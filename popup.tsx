import React, { useEffect, useMemo, useState } from "react"
import { z } from "zod"

// -------- utils --------
const camel = (s: string) => s.replace(/[_-](\w)/g, (_, c) => c.toUpperCase())
const isIdent = (k: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)
const FREE_CAP_BYTES = 3000 // ~3 KB free-tier limit

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function transformKeys(value: any, camelCase: boolean): any {
  if (!camelCase || value == null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((v) => transformKeys(v, camelCase))
  const out: any = {}
  for (const [k, v] of Object.entries(value)) out[camel(k)] = transformKeys(v, camelCase)
  return out
}

// Infer TypeScript from sample
function inferTs(value: any, name = "Root", opts: { camelCase: boolean; nullableUnion: boolean; enumDetect: boolean } = { camelCase: false, nullableUnion: true, enumDetect: true }): string {
  const lines: string[] = []

  function unionWithNull(base: string, hasNull: boolean) {
    return hasNull && opts.nullableUnion ? `${base} | null` : base
  }

  function inferArray(arr: any[], n: string): string {
    if (arr.length === 0) return "unknown[]"
    if (opts.enumDetect && arr.every((x) => typeof x === "string")) {
      const uniq = Array.from(new Set(arr as string[]))
      if (uniq.length > 0 && uniq.length <= 10) return `(${uniq.map((x) => JSON.stringify(x)).join(" | ")})[]`
    }
    return `${walk(arr[0], n + "Item")}[]`
  }

  function walk(v: any, n: string): string {
    if (v === null) return opts.nullableUnion ? "null" : "any"
    const t = typeof v
    if (t === "string") return "string"
    if (t === "number") return "number"
    if (t === "boolean") return "boolean"
    if (Array.isArray(v)) return inferArray(v, n)
    if (t === "object") {
      const entries = Object.entries(v)
      if (!entries.length) return "Record<string, unknown>"
      const fields: string[] = []
      for (const [k, val] of entries) {
        const key = isIdent(k) ? k : JSON.stringify(k)
        if (val === null) {
          fields.push(`  ${key}: ${unionWithNull("any", true)};`)
          continue
        }
        fields.push(`  ${key}: ${unionWithNull(walk(val, k), false)};`)
      }
      const iface = `export interface ${n} {\n${fields.join("\n")}\n}`
      lines.push(iface)
      return n
    }
    return "unknown"
  }

  const root = walk(value, name)
  if (!lines.some((l) => l.startsWith(`export interface ${root} `))) lines.push(`export interface ${name} {}`)
  return lines.join("\n\n")
}

// Infer simple Zod from sample
function inferZod(value: any): string {
  if (value === null) return "z.null()"
  const t = typeof value
  if (t === "string") return "z.string()"
  if (t === "number") return "z.number()"
  if (t === "boolean") return "z.boolean()"
  if (Array.isArray(value)) return `z.array(${inferZod(value[0] ?? null)})`
  if (t === "object") {
    const entries = Object.entries(value)
    if (!entries.length) return "z.record(z.any())"
    const fields = entries.map(([k, v]) => `${isIdent(k) ? k : JSON.stringify(k)}: ${inferZod(v)}`).join(", ")
    return `z.object({ ${fields} })`
  }
  return "z.any()"
}

function buildClient(
  kind: "fetch" | "axios",
  name: string,
  url: string,
  typeName: string,
  headers: Record<string, string> = {},
  method: string = "GET",
  body?: string
): string {
  const hdr = { Accept: "application/json", ...headers }
  const headerLines = JSON.stringify(hdr, null, 2)
  if (kind === "axios") {
    if (method.toUpperCase() === "GET" || !body) {
      return `import axios from 'axios'\nexport async function ${name}(): Promise<${typeName}> {\n  const { data } = await axios.get(${JSON.stringify(url)}, { headers: ${headerLines} })\n  return data as ${typeName}\n}`
    }
    return `import axios from 'axios'\nexport async function ${name}(): Promise<${typeName}> {\n  const { data } = await axios(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: ${headerLines}, data: ${body} })\n  return data as ${typeName}\n}`
  }
  if (method.toUpperCase() === "GET" || !body) {
    return `export async function ${name}(): Promise<${typeName}> {\n  const res = await fetch(${JSON.stringify(url)}, { headers: ${headerLines} })\n  if (!res.ok) throw new Error('HTTP ' + res.status)\n  const data = await res.json()\n  return data as ${typeName}\n}`
  }
  return `export async function ${name}(): Promise<${typeName}> {\n  const res = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: ${headerLines}, body: ${body} })\n  if (!res.ok) throw new Error('HTTP ' + res.status)\n  const data = await res.json()\n  return data as ${typeName}\n}`
}

function parseCurl(cmd: string): { url?: string; headers: Record<string, string>; method?: string; body?: string } {
  const headers: Record<string, string> = {}
  const headerRe = /-H\s+"([^"]+)"|-H\s+'([^']+)'/g
  let match
  while ((match = headerRe.exec(cmd))) {
    const raw = match[1] || match[2]
    const [k, v] = raw.split(":").map((s) => s.trim())
    if (k && v) headers[k] = v
  }
  const urlMatch = cmd.match(/https?:[^\s"']+/)
  const methodMatch = cmd.match(/--request\s+(\w+)|-X\s+(\w+)/i)
  const dataMatch = cmd.match(/--data(?:-raw|-binary)?\s+"([\s\S]*?)"|--data(?:-raw|-binary)?\s+'([\s\S]*?)'|--data(?:-raw|-binary)?\s+([^\s"']+)/)
  let body: string | undefined
  if (dataMatch) {
    const raw = dataMatch[1] || dataMatch[2] || dataMatch[3]
    body = /^[\[{]/.test(raw) ? raw : JSON.stringify(raw)
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json"
  }
  return { url: urlMatch ? urlMatch[0] : undefined, headers, method: methodMatch?.[1] || methodMatch?.[2] || (body ? "POST" : "GET"), body }
}

// -------- UI --------
const sampleJson = `{"id":1,"name":"Alice","email":"a@x.com"}`

type Mode = "json" | "url" | "curl"

type CardProps = { title: string; code?: string; onCopy?: () => void; children?: React.ReactNode; downloadDisabled?: boolean }

function IndexPopup() {
  const [mode, setMode] = useState<Mode>("json")
  // separate buffers
  const [jsonInput, setJsonInput] = useState(sampleJson)
  const [urlValue, setUrlValue] = useState("https://jsonplaceholder.typicode.com/users/1")
  const [urlAuth, setUrlAuth] = useState("")
  const [curlValue, setCurlValue] = useState("")
  const [urlPreview, setUrlPreview] = useState("")
  const [curlPreview, setCurlPreview] = useState("")

  const [typeName, setTypeName] = useState("Root")
  const [toast, setToast] = useState<string>("")
  const [showZod, setShowZod] = useState(true)
  const [camelCase, setCamelCase] = useState(true)
  const [nullableUnion, setNullableUnion] = useState(true)
  const [enumDetect, setEnumDetect] = useState(true)
  const [clientKind, setClientKind] = useState<"fetch" | "axios">("fetch")
  const [urlError, setUrlError] = useState<string>("")
  const [curlHeaders, setCurlHeaders] = useState<Record<string, string>>({})
  const [clientMethod, setClientMethod] = useState<string>("GET")
  const [clientBody, setClientBody] = useState<string | undefined>(undefined)

  // simple local license (Pro) gate
  const [licenseKey, setLicenseKey] = useState("")
  const pro = useMemo(() => (licenseKey && licenseKey.replace(/-/g, "").length >= 16), [licenseKey])

  // Persist minimal settings
  useEffect(() => {
    const s = (globalThis as any).chrome?.storage?.local
    s?.get(["mode","jsonInput","urlValue","urlAuth","curlValue","typeName","showZod","camelCase","nullableUnion","enumDetect","clientKind","licenseKey"], (res: any) => {
      if (res?.mode) setMode(res.mode)
      if (res?.jsonInput) setJsonInput(res.jsonInput)
      if (res?.urlValue) setUrlValue(res.urlValue)
      if (res?.urlAuth) setUrlAuth(res.urlAuth)
      if (res?.curlValue) setCurlValue(res.curlValue)
      if (res?.typeName) setTypeName(res.typeName)
      if (typeof res?.showZod === "boolean") setShowZod(res.showZod)
      if (typeof res?.camelCase === "boolean") setCamelCase(res.camelCase)
      if (typeof res?.nullableUnion === "boolean") setNullableUnion(res.nullableUnion)
      if (typeof res?.enumDetect === "boolean") setEnumDetect(res.enumDetect)
      if (res?.clientKind) setClientKind(res.clientKind)
      if (res?.licenseKey) setLicenseKey(res.licenseKey)
    })
  }, [])
  useEffect(() => {
    const s = (globalThis as any).chrome?.storage?.local
    s?.set({ mode, jsonInput, urlValue, urlAuth, curlValue, typeName, showZod, camelCase, nullableUnion, enumDetect, clientKind, licenseKey })
  }, [mode, jsonInput, urlValue, urlAuth, curlValue, typeName, showZod, camelCase, nullableUnion, enumDetect, clientKind, licenseKey])

  // Free-tier cap enforcement
  const jsonBytes = new TextEncoder().encode(jsonInput).length
  const overCap = !pro && jsonBytes > FREE_CAP_BYTES

  // Generate from JSON buffer only if within cap or Pro
  const parsedRaw = useMemo(() => (overCap ? null : tryParseJson(jsonInput)), [jsonInput, overCap])
  const parsed = useMemo(() => (parsedRaw ? transformKeys(parsedRaw, camelCase) : null), [parsedRaw, camelCase])
  const tsTypes = useMemo(() => (parsed ? inferTs(parsed, typeName, { camelCase, nullableUnion, enumDetect }) : ""), [parsed, typeName, camelCase, nullableUnion, enumDetect])
  const zodCode = useMemo(() => (parsed ? `import { z } from 'zod'\nexport const ${typeName}Schema = ${inferZod(parsed)}` : ""), [parsed, typeName])
  const effectiveClientKind = pro ? clientKind : "fetch"
  const clientCode = useMemo(() => buildClient(effectiveClientKind, "getData", urlValue, typeName, { ...(urlAuth ? { Authorization: urlAuth } : {}), ...curlHeaders }, clientMethod, clientBody), [effectiveClientKind, urlValue, typeName, urlAuth, curlHeaders, clientMethod, clientBody])

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setToast(`${label} copied`)
      setTimeout(() => setToast(""), 1200)
    } catch {
      setToast("Copy failed")
      setTimeout(() => setToast(""), 1200)
    }
  }

  const download = (filename: string, content: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  // URL fetch fills preview only
  const handleUrlFetch = async () => {
    setUrlError("")
    try {
      const headers: Record<string, string> = { Accept: "application/json" }
      if (urlAuth.trim()) headers["Authorization"] = urlAuth.trim()
      const res = await fetch(urlValue, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setUrlPreview(JSON.stringify(data, null, 2))
    } catch (e: any) {
      setUrlError(e?.message || "Fetch failed")
    }
  }

  // curl parse updates urlValue + headers, method/body
  const handleCurlParse = () => {
    const { url, headers, method, body } = parseCurl(curlValue)
    if (url) setUrlValue(url)
    setCurlHeaders(headers)
    if (method) setClientMethod(method)
    setClientBody(body)
    setCurlPreview("")
    setToast("curl parsed")
    setTimeout(() => setToast(""), 1000)
  }

  const TabButton = ({ id, children }: { id: Mode; children: React.ReactNode }) => (
    <button
      onClick={() => setMode(id)}
      disabled={mode === id}
      style={{
        padding: "6px 10px",
        borderRadius: 8,
        border: mode === id ? "1px solid #2563eb" : "1px solid #e5e7eb",
        background: mode === id ? "#eff6ff" : "#fff",
        color: "#111827",
        cursor: mode === id ? "default" : "pointer"
      }}>
      {children}
    </button>
  )

  const Card: React.FC<CardProps> = ({ title, children, code, onCopy, downloadDisabled }) => (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, marginTop: 12, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
        <h3 style={{ margin: 0, fontSize: 13, color: "#111827" }}>{title}</h3>
        <div style={{ display: "flex", gap: 6 }}>
          {onCopy && (
            <button onClick={onCopy} style={{ padding: "4px 8px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", cursor: "pointer" }}>Copy</button>
          )}
          {code && (
            <button onClick={() => !downloadDisabled && download(`${title.replace(/\s+/g, '-').toLowerCase()}.ts`, code)} disabled={!!downloadDisabled} style={{ padding: "4px 8px", border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", cursor: downloadDisabled ? "not-allowed" : "pointer", opacity: downloadDisabled ? 0.6 : 1 }}>{downloadDisabled ? "Download (Pro)" : "Download"}</button>
          )}
        </div>
      </div>
      <div style={{ padding: 10 }}>
        {code ? (
          <pre style={{ whiteSpace: "pre-wrap", background: "#f6f8fa", padding: 8, margin: 0 }}>{code}</pre>
        ) : (
          children
        )}
      </div>
    </div>
  )

  const invalidJson = mode === "json" && jsonInput.trim().length > 0 && parsedRaw == null

  return (
    <div style={{ padding: 16, width: 700, fontFamily: "Inter, ui-sans-serif, system-ui", color: "#111827", background: "#fff" }}>
      {!pro && (
        <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", padding: 8, borderRadius: 8, marginBottom: 10, fontSize: 12 }}>
          Free tier: up to ~3 KB JSON and no file downloads. Enter a license key to unlock Pro.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} placeholder="Enter license key (e.g., from Gumroad)" style={{ flex: 1, padding: 6, border: "1px solid #e5e7eb", borderRadius: 6 }} />
        <span style={{ fontSize: 12, color: pro ? "#166534" : "#9a3412" }}>{pro ? "Pro active" : "Free"}</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h2 style={{ marginTop: 0 }}>JSON → TS + Client</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
          <label><input type="checkbox" checked={showZod} onChange={(e) => setShowZod(e.target.checked)} /> Zod</label>
          <label><input type="checkbox" checked={camelCase} onChange={(e) => setCamelCase(e.target.checked)} /> camelCase</label>
          <label><input type="checkbox" checked={nullableUnion} onChange={(e) => setNullableUnion(e.target.checked)} /> nullable</label>
          <label><input type="checkbox" checked={enumDetect} onChange={(e) => setEnumDetect(e.target.checked)} /> enum</label>
          <select value={effectiveClientKind} onChange={(e) => setClientKind(e.target.value as any)} disabled={!pro} style={{ padding: 4 }}>
            <option value="fetch">fetch</option>
            <option value="axios">axios</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <TabButton id="json">JSON</TabButton>
        <TabButton id="url">URL</TabButton>
        <TabButton id="curl">curl</TabButton>
      </div>

      {mode === "json" && (
        <Card title="Input JSON">
          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <button onClick={() => { const obj = tryParseJson(jsonInput); if (obj != null) setJsonInput(JSON.stringify(obj, null, 2)) }} style={{ padding: "6px 10px" }}>Prettify</button>
            <button onClick={() => setJsonInput("")} style={{ padding: "6px 10px" }}>Clear</button>
            {overCap && <span style={{ alignSelf: "center", fontSize: 12, color: "#b91c1c" }}>Over free cap (~3 KB) — paste smaller or unlock Pro</span>}
          </div>
          <textarea
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            onPaste={(e) => { const text = e.clipboardData.getData("text"); try { const obj = JSON.parse(text); e.preventDefault(); setJsonInput(JSON.stringify(obj, null, 2)) } catch {} }}
            onBlur={() => { const obj = tryParseJson(jsonInput); if (obj != null) setJsonInput(JSON.stringify(obj, null, 2)) }}
            placeholder="Paste JSON"
            style={{ width: "100%", height: 160, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />
          {invalidJson && <div style={{ marginTop: 6, color: "#b91c1c", fontSize: 12 }}>Invalid JSON</div>}
        </Card>
      )}

      {mode === "url" && (
        <Card title="Request URL">
          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <input value={urlValue} onChange={(e) => setUrlValue(e.target.value)} placeholder="https://api.example.com/path" style={{ flex: 1, padding: 8, border: "1px solid #e5e7eb", borderRadius: 6 }} />
            <button onClick={handleUrlFetch} style={{ padding: "8px 10px" }}>Fetch</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 6 }}>
            <label style={{ width: 110 }}>Authorization:</label>
            <input value={urlAuth} onChange={(e) => setUrlAuth(e.target.value)} placeholder="Bearer YOUR_TOKEN" style={{ flex: 1, padding: 6, border: "1px solid #e5e7eb", borderRadius: 6 }} />
          </div>
          {urlError && <div style={{ marginTop: 6, color: "#b91c1c", fontSize: 12 }}>{urlError}</div>}
          {urlPreview && (
            <div style={{ marginTop: 8 }}>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f8fa", padding: 8 }}>{urlPreview}</pre>
              <button onClick={() => setJsonInput(urlPreview)} style={{ marginTop: 6, padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 6 }}>Use in JSON</button>
            </div>
          )}
        </Card>
      )}

      {mode === "curl" && (
        <Card title="curl">
          <div style={{ display: "flex", gap: 8 }}>
            <input value={curlValue} onChange={(e) => setCurlValue(e.target.value)} placeholder={`curl -X POST -H 'Authorization: Bearer ...' --data '{"name":"Alice"}' https://api.example.com/users`} style={{ flex: 1, padding: 8, border: "1px solid #e5e7eb", borderRadius: 6 }} />
            <button onClick={handleCurlParse} style={{ padding: "8px 10px" }}>Parse</button>
          </div>
          {Object.keys(curlHeaders).length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Parsed headers: {Object.entries(curlHeaders).map(([k,v]) => `${k}: ${v}`).join("; ")}
            </div>
          )}
          {clientBody && (
            <div style={{ marginTop: 6, fontSize: 12 }}>Detected body: <code>{clientBody}</code></div>
          )}
        </Card>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input value={typeName} onChange={(e) => setTypeName(e.target.value)} placeholder="Root type name" style={{ flex: 1, padding: 8, border: "1px solid #e5e7eb", borderRadius: 6 }} />
      </div>

      <Card title="types" onCopy={tsTypes ? () => copy(tsTypes, "Types") : undefined} downloadDisabled={!pro} code={tsTypes || (overCap ? "/* Over free cap — unlock Pro or reduce JSON */" : "/* Paste/fetch JSON to generate types */")} />

      {showZod && <Card title="zod" onCopy={parsed ? () => copy(zodCode, "Zod") : undefined} downloadDisabled={!pro} code={zodCode || (overCap ? "/* Over free cap — unlock Pro or reduce JSON */" : "/* Enable Zod and provide JSON */")} />}

      <Card title={`${effectiveClientKind} client`} onCopy={() => copy(clientCode, "Client")} downloadDisabled={!pro} code={clientCode} />

      {toast && (
        <div style={{ position: "fixed", bottom: 12, right: 12, background: "#111827", color: "#fff", padding: "6px 10px", borderRadius: 6, fontSize: 12 }}>{toast}</div>
      )}
    </div>
  )
}

export default IndexPopup

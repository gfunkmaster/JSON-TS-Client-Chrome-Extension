function parseCurl(cmd) {
  const headers = {}
  const headerRe = /-H\s+"([^"]+)"|-H\s+'([^']+)'/g
  let match
  while ((match = headerRe.exec(cmd))) {
    const raw = match[1] || match[2]
    const [k, v] = raw.split(":").map((s) => s.trim())
    if (k && v) headers[k] = v
  }
  const urlMatch = cmd.match(/https?:[^\s"']+/)
  return { url: urlMatch ? urlMatch[0] : undefined, headers }
}

const samples = [
  "curl -H \"Authorization: Bearer TOKEN\" -H 'Accept: application/json' https://api.example.com/users?page=1",
  "curl https://jsonplaceholder.typicode.com/users",
]

for (const s of samples) {
  console.log("INPUT:", s)
  console.log("PARSED:", parseCurl(s))
}

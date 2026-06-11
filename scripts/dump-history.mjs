import initSqlJs from 'sql.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dbPath = process.argv[2]
const SQL = await initSqlJs({
  locateFile: (f) => join(process.cwd(), 'node_modules', 'sql.js', 'dist', f)
})
const db = new SQL.Database(readFileSync(dbPath))
const res = db.exec(
  `SELECT id, datetime(created_at/1000,'unixepoch','localtime') AS at, status, word_count AS words,
          latency_ms AS ms, app_context AS app, substr(raw_text,1,90) AS text, length(cleaned_text) AS cleaned_len
   FROM transcripts ORDER BY id DESC LIMIT 25`
)
if (!res.length) {
  console.log('NO ROWS — the transcripts table is empty (no dictation recorded yet).')
} else {
  const { columns, values } = res[0]
  console.log(`rows: ${values.length}`)
  for (const row of values) {
    const o = {}
    columns.forEach((c, i) => (o[c] = row[i]))
    console.log(JSON.stringify(o))
  }
}

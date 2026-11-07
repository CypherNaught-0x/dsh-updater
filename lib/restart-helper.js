// Detached process started by scheduleRestart(): it outlives the DSH server it restarts.
import { readFileSync, unlinkSync } from 'node:fs'
import { runRestartJob } from './restart.js'

const jobFile = process.argv[2]
const job = JSON.parse(readFileSync(jobFile, 'utf8'))
try { unlinkSync(jobFile) } catch {}
try {
  const report = await runRestartJob(job)
  process.stdout.write(`dsh-updater: restart ${report.status}: ${report.message}\n`)
  process.exit(0)
} catch (error) {
  process.stderr.write(`dsh-updater: restart helper failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
}

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function major(version) {
  const match = /^v?(\d+)/.exec(version.trim())
  return match ? Number(match[1]) : null
}

export function checkToolchain(actual) {
  const issues = []
  const nodeMajor = major(actual.node)
  const npmMajor = major(actual.npm)

  if (nodeMajor === null) issues.push(`Could not determine the Node.js version (${actual.node || 'empty'}).`)
  else if (nodeMajor < 20) issues.push(`Node.js 20 or newer is required; found ${actual.node}.`)

  if (npmMajor === null) issues.push('Could not determine the npm version.')
  else if (npmMajor < 10) issues.push(`npm 10 or newer is required; found ${actual.npm}.`)

  return issues
}

function npmVersion() {
  const userAgent = process.env.npm_config_user_agent ?? ''
  const fromAgent = /(?:^|\s)npm\/([^\s]+)/.exec(userAgent)?.[1]
  if (fromAgent) return fromAgent
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function main() {
  const issues = checkToolchain({ node: process.version, npm: npmVersion() })
  if (!issues.length) {
    process.stdout.write(`Toolchain ready: Node ${process.version}, npm ${npmVersion()}.\n`)
    return
  }
  for (const issue of issues) process.stderr.write(`${issue}\n`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

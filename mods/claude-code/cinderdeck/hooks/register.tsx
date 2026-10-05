import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CinderdeckService, CinderdeckWorkspace } from '../types'

const PANE = 'cinderdeck'
const POLL_MS = 15_000
const LOG_LINES = 60

const workspace = atom({ plugin: 'cinderdeck', key: 'workspace' } as const, null)
const problem = atom({ plugin: 'cinderdeck', key: 'problem' } as const, null)
const logs = atom({ plugin: 'cinderdeck', key: 'logs' } as const, null)

type Json = Record<string, unknown>

const ANSI = /\u001b\[[0-9;]*m/g
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The workspace whose repository contains `cwd`, deepest repository path first. */
function pickWorkspace(snapshot: Json, cwd: string): CinderdeckWorkspace | null {
  let best: { depth: number; workspace: Json } | null = null
  for (const candidate of asArray(snapshot.workspaces)) {
    const roots = [
      asString(candidate.root),
      ...asArray(candidate.repos).map(repo => asString(repo.path)),
    ]
    for (const root of roots) {
      if (root === null) continue
      const inside = cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
      if (inside && (best === null || root.length > best.depth)) {
        best = { depth: root.length, workspace: candidate }
      }
    }
  }
  if (best === null) return null
  const found = best.workspace
  return {
    id: asString(found.id) ?? '',
    name: asString(found.name) ?? asString(found.id) ?? 'workspace',
    state: asString(found.state) ?? 'unknown',
    services: asArray(found.services).map(service => ({
      name: asString(service.name) ?? '?',
      status: asString(service.status) ?? asString(service.phase) ?? 'unknown',
      ready: service.ready === true,
      port: typeof service.port === 'number' ? service.port : null,
      url: asString(service.url),
      detail: asString(service.detail),
    })),
  }
}

const isFailing = (service: CinderdeckService) => /fail|crash|exit|error/i.test(service.status)

function summarize(found: CinderdeckWorkspace): string {
  const failing = found.services.filter(isFailing)
  if (failing.length > 0) {
    return `Cinderdeck ${found.name}: ${failing.map(service => service.name).join(', ')} failing`
  }
  const ready = found.services.filter(service => service.ready).length
  return `Cinderdeck ${found.name}: ${ready}/${found.services.length} ready`
}

async function cinderdeck($: EngineInterface, args: string[], timeoutMs = 20_000) {
  return $.process.run(['cinderdeck', ...args], { timeoutMs })
}

async function refresh($: EngineInterface) {
  let result
  try {
    result = await cinderdeck($, ['services', 'status', '--json'], 10_000)
  } catch {
    await update($, problem, () => 'The cinderdeck CLI is not installed. Run "Install CLI" in Cinderdeck.')
    $.ui.status(undefined)
    return
  }
  if (result.exitCode !== 0) {
    await update($, problem, () => 'Cinderdeck is not running.')
    $.ui.status(undefined)
    return
  }
  let snapshot: Json
  try {
    snapshot = JSON.parse(result.stdout) as Json
  } catch {
    await update($, problem, () => 'Cinderdeck answered with something other than JSON.')
    return
  }
  const found = pickWorkspace(snapshot, await $.session.cwd())
  const previous = await read($, workspace)
  if (found !== null && previous !== null && previous.id === found.id) {
    for (const service of found.services) {
      const before = previous.services.find(one => one.name === service.name)
      if (before !== undefined && !isFailing(before) && isFailing(service)) {
        $.ui.toast(`Cinderdeck: ${service.name} ${service.status}${service.detail ? ` (${service.detail})` : ''}`)
      }
    }
  }
  await update($, problem, () => (found === null ? 'This folder is not part of a Cinderdeck workspace.' : null))
  await update($, workspace, () => found)
  $.ui.status(found === null ? undefined : summarize(found))
}

async function readLogs($: EngineInterface, workspaceId: string, service: string) {
  const result = await cinderdeck($, ['services', 'logs', workspaceId, service, '-n', String(LOG_LINES)])
  const text = (result.exitCode === 0 ? result.stdout : result.stderr).replace(ANSI, '')
  return text.split('\n').filter(line => line.trim() !== '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cinderdeck',
      description: 'Cinderdeck workspace pane; "/cinderdeck logs <service>" hands recent logs to Claude',
    })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'cinderdeck' }, async ($, e) => {
    const [verb, service] = e.args.trim().split(/\s+/)
    if (verb === 'logs' && service) {
      const found = await read($, workspace)
      if (found === null) return { text: 'This folder is not part of a running Cinderdeck workspace.' }
      const lines = await readLogs($, found.id, service)
      return {
        text: `Last ${lines.length} log lines of ${service} in Cinderdeck workspace ${found.name}:\n\n${lines.join('\n')}`,
      }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Cinderdeck' })

    return { text: 'Cinderdeck pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const found = await read($, workspace)
    const issue = await read($, problem)
    const shown = await read($, logs)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - (found?.services.length ?? 0) - 8)

    if (found === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{issue ?? 'Looking for Cinderdeck…'}</Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {found.name} · {found.state}
        </Text>
        {found.services.map(service => (
          <Box key={`row-${service.name}`} flexDirection="row" gap={1}>
            <Text color={isFailing(service) ? 'red' : service.ready ? 'green' : 'yellow'}>
              {service.ready ? '●' : '○'} {service.name}
            </Text>
            <Text dimColor>
              {service.status}
              {service.port !== null ? ` :${service.port}` : ''}
            </Text>
            <Button
              key={`logs-${service.name}`}
              label="logs"
              plain
              onPress={async () => {
                const lines = await readLogs($, found.id, service.name)
                await update($, logs, () => ({ service: service.name, lines }))
              }}
            />
            <Button
              key={`restart-${service.name}`}
              label="restart"
              plain
              onPress={async () => {
                $.ui.toast(`Restarting ${service.name}…`)
                const result = await cinderdeck($, ['services', 'restart', found.id, service.name], 180_000)
                $.ui.toast(result.exitCode === 0 ? `${service.name} restarted` : `Restart failed: ${result.stderr.trim()}`)
                await refresh($)
              }}
            />
          </Box>
        ))}
        {shown !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{shown.service} logs</Text>
            {shown.lines.slice(-room).map((line, index) => (
              <Text key={`log-${index}`} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}

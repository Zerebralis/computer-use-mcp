import assert from 'node:assert/strict'
import test from 'node:test'
import { handleWindowTool } from '../dist/session/window-handlers.js'

function context({ activations = [], runScript } = {}) {
  const updates = []
  const native = {
    activateApp(bundleId, timeoutMs) {
      const next = activations.length ? activations.shift() : false
      return { bundleId, activated: next, displayName: bundleId, timeoutMs }
    },
  }
  return {
    updates,
    native,
    value: {
      native,
      targets: { update(target, reason) { updates.push({ target, reason }) } },
      platform: 'win32',
      defaultProvider: 'auto',
      sleep: async () => {},
      sleepAbortable: async () => false,
      runScript: runScript ?? (async () => ({ stdout: '1234', stderr: '', code: 0, timedOut: false })),
    },
  }
}

test('non-Windows open_application preserves native activation behavior without Windows launch fallback', async () => {
  let launches = 0
  const f = context({ activations: [false], runScript: async () => { launches++; return { stdout: '', stderr: '', code: 0, timedOut: false } } })
  f.value.platform = 'darwin'
  const result = await handleWindowTool('open_application', { bundle_id: 'com.apple.TextEdit' }, f.value)
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].text, 'Opened com.apple.TextEdit (activated: false)')
  assert.equal(launches, 0)
  assert.equal(f.updates.length, 0)
})

test('Windows open_application activates an already-running app without launching another process', async () => {
  let launches = 0
  const f = context({ activations: [true], runScript: async () => { launches++; return { stdout: '', stderr: '', code: 0, timedOut: false } } })
  const result = await handleWindowTool('open_application', { bundle_id: 'notepad.exe' }, f.value)
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].text, 'Opened notepad.exe (activated: true)')
  assert.equal(launches, 0)
  assert.deepEqual(f.updates, [{ target: { bundleId: 'notepad.exe' }, reason: 'activation' }])
})

test('Windows open_application launches a missing safe executable basename then requires a real activated window', async () => {
  const calls = []
  const f = context({ activations: [false, false, true], runScript: async (language, script, timeoutMs) => {
    calls.push({ language, script, timeoutMs })
    return { stdout: '4321', stderr: '', code: 0, timedOut: false }
  } })
  const result = await handleWindowTool('open_application', { bundle_id: 'notepad.exe' }, f.value)
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].text, 'Opened notepad.exe (activated: true)')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].language, 'powershell')
  assert.equal(calls[0].timeoutMs, 5000)
  assert.match(calls[0].script, /Start-Process -FilePath 'notepad\.exe' -PassThru/)
  assert.deepEqual(f.updates, [{ target: { bundleId: 'notepad.exe' }, reason: 'activation' }])
})

test('Windows open_application rejects paths and shell-shaped names before launch', async () => {
  for (const bundle_id of ['C:\\Windows\\notepad.exe', 'notepad.exe;calc.exe', "notepad.exe'", '../notepad.exe']) {
    let launches = 0
    const f = context({ activations: [false], runScript: async () => { launches++; return { stdout: '', stderr: '', code: 0, timedOut: false } } })
    const result = await handleWindowTool('open_application', { bundle_id }, f.value)
    assert.equal(result.isError, true, bundle_id)
    assert.equal(launches, 0, bundle_id)
    assert.equal(f.updates.length, 0, bundle_id)
  }
})

test('Windows open_application never reports success when process launch fails', async () => {
  const f = context({ activations: [false], runScript: async () => ({ stdout: '', stderr: 'private provider prose', code: 1, timedOut: false }) })
  const result = await handleWindowTool('open_application', { bundle_id: 'missing.exe' }, f.value)
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, 'Failed to open missing.exe')
  assert.doesNotMatch(result.content[0].text, /private provider prose/)
  assert.equal(f.updates.length, 0)
})

test('Windows open_application reports failure when launch produced no activatable window', async () => {
  const f = context({ activations: Array(31).fill(false) })
  const result = await handleWindowTool('open_application', { bundle_id: 'notepad.exe' }, f.value)
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, 'Application launched but no activatable window appeared: notepad.exe')
  assert.equal(f.updates.length, 0)
})

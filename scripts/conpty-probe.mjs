import { DshTuiController } from '../src/app/controller.ts'
import {
  PiTerminalDriver,
  TERMINAL_RECOVERY_SEQUENCE,
} from '../src/terminal/driver.ts'
import {
  SCRIPTED_ASSISTANT_TEXT,
  SCRIPTED_DURABLE_SEQS,
  SCRIPTED_TOOL_NAME,
  ScriptedProductPort,
} from '../tests/fakes/scripted-product-port.ts'

const scenario = process.argv[2] ?? 'driver'
const expectedPrompt = process.argv[3] ?? ''
if (!['driver', 'controller-flow', 'controller-force'].includes(scenario)) {
  throw new Error(`unknown ConPTY probe scenario: ${scenario}`)
}

let finishing = false
let watchdog
let restoreStart
const productWrites = []
const lifecycle = []
const applicationCounts = { request: 0, force: 0 }

function marker(message) {
  process.stdout.write(`[DSH-CONPTY] ${message}\r\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function recordLifecycle(phase) {
  lifecycle.push(phase)
  marker(`LIFECYCLE ${phase}`)
}

function trace(message) {
  const lifecycleMatch = /^LIFECYCLE ([^ ]+)/u.exec(message)
  if (lifecycleMatch !== null) lifecycle.push(lifecycleMatch[1])
  marker(message)
}

const productOutput = {
  get isTTY() { return process.stdout.isTTY },
  get columns() { return process.stdout.columns },
  get rows() { return process.stdout.rows },
  write(data) {
    productWrites.push(data)
    return process.stdout.write(data)
  },
  on(event, listener) {
    process.stdout.on(event, listener)
    return productOutput
  },
  removeListener(event, listener) {
    process.stdout.removeListener(event, listener)
    return productOutput
  },
}

const driver = new PiTerminalDriver({
  output: productOutput,
  logDirectory: process.env.DSH_CONPTY_LOG_DIR ?? process.cwd(),
})

function writeHexEvidence(label, value) {
  const hex = Buffer.from(value).toString('hex')
  const chunkSize = 48
  for (let offset = 0; offset < hex.length; offset += chunkSize) {
    const index = offset / chunkSize
    marker(`${label}_HEX ${index}:${hex.slice(offset, offset + chunkSize)}`)
  }
  marker(`${label}_DONE ${hex.length}`)
}

function finish(exitCode) {
  if (finishing) return
  finishing = true
  clearTimeout(watchdog)
  if (driver.state !== 'restored') {
    driver.stopAcceptingInput()
    restoreStart ??= productWrites.length
    driver.restore()
  }
  const restoreWrites = productWrites.slice(restoreStart ?? productWrites.length).join('')
  writeHexEvidence('RECOVERY', TERMINAL_RECOVERY_SEQUENCE)
  writeHexEvidence('RESTORE', restoreWrites)
  marker(
    `RECOVERY_MATCH ${restoreWrites.endsWith(TERMINAL_RECOVERY_SEQUENCE) ? 'exact' : 'mismatch'}`,
  )
  process.stdout.write('[DSH-CONPTY] RESTORED\r\n', () => {
    process.exit(exitCode)
  })
}

async function runDriverScenario() {
  await new Promise(resolve => {
    let finishScheduled = false
    driver.start({
      onInput(action) {
        if (action.type !== 'interrupt' || finishScheduled) return
        finishScheduled = true
        marker('CTRL_C')
        setImmediate(() => {
          driver.stopAcceptingInput()
          restoreStart = productWrites.length
          driver.restore()
          resolve()
        })
      },
      onResize(viewport) {
        marker(`RESIZE ${viewport.columns}x${viewport.rows}`)
      },
    })
    const initial = driver.viewport
    marker(`READY ${initial.columns}x${initial.rows}`)
  })
}

async function runControllerScenario() {
  assert(expectedPrompt !== '', 'controller ConPTY scenario requires an expected prompt')
  let flowFrameSeen = false
  let flowReadyWritten = false
  let port

  const maybeMarkFlowReady = () => {
    if (
      scenario === 'controller-flow'
      && !flowReadyWritten
      && flowFrameSeen
      && port?.finalIdleObserved === true
      && port.consumedDurableSeqs.join(',') === SCRIPTED_DURABLE_SEQS.join(',')
    ) {
      flowReadyWritten = true
      marker('FLOW_READY_TO_EXIT')
    }
  }

  port = new ScriptedProductPort({
    scenario,
    expectedPrompt,
    trace,
    onProgress: maybeMarkFlowReady,
  })

  const terminal = {
    deferConversationFlatFallback: true,
    get state() { return driver.state },
    get viewport() { return driver.viewport },
    start(callbacks) {
      driver.start({
        onInput(action) {
          if (action.type === 'interrupt') {
            setImmediate(() => callbacks.onInput(action))
          } else {
            callbacks.onInput(action)
          }
        },
        onResize(viewport) {
          marker(`RESIZE ${viewport.columns}x${viewport.rows}`)
          callbacks.onResize(viewport)
        },
      })
    },
    render(frame) {
      driver.render(frame)
      // Retained-mode product frames intentionally defer the duplicate flat
      // transcript. Materialize it only for this test assertion.
      const evidenceFrame = frame.flatFallback?.() ?? frame
      const text = evidenceFrame.lines.join('\n')
      if (
        text.includes(`› ${expectedPrompt}`)
        && text.includes(SCRIPTED_ASSISTANT_TEXT)
        && text.includes('✓ Completed 1 execution step · request succeeded · Ctrl+O for details')
        && !text.includes('durable assistant draft')
      ) {
        flowFrameSeen = true
        maybeMarkFlowReady()
      }
    },
    stopAcceptingInput() {
      driver.stopAcceptingInput()
      restoreStart ??= productWrites.length
      recordLifecycle('stop-input')
    },
    restore() {
      driver.restore()
      recordLifecycle('restore-terminal')
    },
  }

  const assertRestoredAtExit = kind => {
    const restoreWrites = productWrites.slice(restoreStart ?? productWrites.length).join('')
    assert(driver.state === 'restored', `${kind} callback ran before TerminalDriver.restore()`)
    assert(
      restoreWrites.endsWith(TERMINAL_RECOVERY_SEQUENCE),
      `${kind} callback observed a non-exact terminal recovery suffix`,
    )
    marker(`APP_EXIT ${kind} restore=exact`)
  }

  const application = {
    requestExit() {
      applicationCounts.request += 1
      assertRestoredAtExit('request')
      recordLifecycle('request-app-exit')
    },
    forceExit() {
      applicationCounts.force += 1
      assertRestoredAtExit('force')
      recordLifecycle('force-exit')
    },
  }

  const controller = new DshTuiController({
    session: port,
    terminal,
    application,
    frameIntervalMs: 1,
  })
  await controller.start()
  await port.waitForInitialRuntime()
  const initial = driver.viewport
  marker(`READY ${initial.columns}x${initial.rows}`)

  const result = await controller.wait()
  const expectedLifecycle = scenario === 'controller-flow'
    ? [
        'stop-input',
        'settle-interactions',
        'cancel-agent',
        'when-idle',
        'flush-session',
        'dispose-runtime',
        'restore-terminal',
        'request-app-exit',
      ]
    : [
        'stop-input',
        'settle-interactions',
        'cancel-agent',
        'when-idle',
        'restore-terminal',
        'force-exit',
      ]
  assert(
    lifecycle.join(',') === expectedLifecycle.join(','),
    `unexpected shutdown lifecycle: ${lifecycle.join(',')}`,
  )

  if (scenario === 'controller-flow') {
    assert(result.ok === true && result.reason === 'user', 'flow did not finish as a user exit')
    assert(result.shutdown.mode === 'graceful', 'flow did not use graceful shutdown')
    assert(flowFrameSeen, 'flow never rendered its durable user/assistant/tool frame')
    assert(port.submitted.length === 1, 'flow did not submit exactly once')
    assert(port.cancellations.length === 1, 'flow did not cancel its owned Agent exactly once')
    assert(port.disposeInteractionsCount === 1, 'flow did not settle interactions exactly once')
    assert(port.whenIdleCount === 1, 'flow did not await idle exactly once')
    assert(port.flushCount === 1, 'flow did not flush exactly once')
    assert(port.disposeCount === 1, 'flow did not dispose runtime exactly once')
    assert(applicationCounts.request === 1, 'flow did not request app exit exactly once')
    assert(applicationCounts.force === 0, 'flow unexpectedly forced app exit')
    const submitted = port.submitted[0]
    marker(
      `SUBMIT_EVIDENCE delivery=${submitted.delivery}`
      + ` text_hex=${Buffer.from(submitted.input.text).toString('hex')}`,
    )
    marker(`DURABLE_SEQS ${port.consumedDurableSeqs.join(',')}`)
    marker('CONTROLLER_RESULT ok=true reason=user shutdown=graceful')
  } else {
    assert(result.ok === false && result.reason === 'forced', 'force scenario did not force exit')
    assert(result.shutdown.mode === 'forced', 'force scenario returned a non-forced shutdown')
    assert(port.submitted.length === 0, 'quiescing ordinary input reached submit')
    assert(port.cancellations.length === 1, 'force scenario did not cancel its owned Agent exactly once')
    assert(port.disposeInteractionsCount === 1, 'force did not settle interactions exactly once')
    assert(port.whenIdleCount === 1, 'first interrupt did not reach the blocked idle wait')
    assert(port.flushCount === 0, 'forced shutdown unexpectedly flushed')
    assert(port.disposeCount === 0, 'forced shutdown unexpectedly waited for runtime disposal')
    assert(applicationCounts.request === 0, 'forced shutdown unexpectedly requested normal exit')
    assert(applicationCounts.force === 1, 'forced shutdown did not force app exit exactly once')
    marker('QUIESCING_INPUT submit=0')
    marker('CONTROLLER_RESULT ok=false reason=forced shutdown=forced')
  }

  marker(
    `COUNTS submit=${port.submitted.length} cancel=${port.cancellations.length}`
    + ` settle=${port.disposeInteractionsCount} whenIdle=${port.whenIdleCount}`
    + ` flush=${port.flushCount} dispose=${port.disposeCount}`
    + ` requestExit=${applicationCounts.request} forceExit=${applicationCounts.force}`,
  )
}

watchdog = setTimeout(() => {
  marker('WATCHDOG_TIMEOUT')
  finish(3)
}, 15_000)

process.on('exit', () => driver.restore())

try {
  if (scenario === 'driver') await runDriverScenario()
  else await runControllerScenario()
  finish(0)
} catch (error) {
  marker(`PROBE_ERROR ${error instanceof Error ? error.message : String(error)}`)
  finish(2)
}

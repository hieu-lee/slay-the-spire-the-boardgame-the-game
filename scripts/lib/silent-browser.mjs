import { chromium as chromiumEngine, webkit as webkitEngine } from 'playwright'
export { devices } from 'playwright'

/** Silence this test document's output without disabling playback, decoding, or sound assertions. */
export function silenceBrowserAudio() {
  const installed = Symbol.for('sts-test-audio-muted')
  if (globalThis[installed]) return
  Object.defineProperty(globalThis, installed, { value: true })

  const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')
  if (!muted?.set) throw new Error('Cannot silence browser media output')
  const mute = media => muted.set.call(media, true)
  Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
    ...muted,
    set() { mute(this) },
  })
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...args) {
    mute(this)
    return play.apply(this, args)
  }
  globalThis.Audio = new Proxy(Audio, {
    construct(target, args, newTarget) {
      const media = Reflect.construct(target, args, newTarget)
      mute(media)
      return media
    },
    apply(target, receiver, args) {
      const media = Reflect.apply(target, receiver, args)
      mute(media)
      return media
    },
  })
  const muteTree = node => {
    if (!(node instanceof Element)) return
    if (node.matches('audio, video')) mute(node)
    node.querySelectorAll('audio, video').forEach(mute)
  }
  if (document.documentElement) muteTree(document.documentElement)
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(muteTree)))
    .observe(document, { childList: true, subtree: true })
  document.addEventListener('play', event => {
    if (event.target instanceof HTMLMediaElement) mute(event.target)
  }, true)

  if (typeof AudioNode === 'undefined') return
  const connect = AudioNode.prototype.connect
  const disconnect = AudioNode.prototype.disconnect
  const outputs = new WeakMap()
  AudioNode.prototype.connect = function (destination, ...ports) {
    if (!(destination instanceof AudioDestinationNode) ||
      destination.context instanceof OfflineAudioContext) return connect.call(this, destination, ...ports)
    let output = outputs.get(destination)
    if (!output) {
      output = destination.context.createGain()
      output.gain.value = 0
      connect.call(output, destination)
      outputs.set(destination, output)
    }
    connect.call(this, output, ...ports)
    return destination
  }
  AudioNode.prototype.disconnect = function (...args) {
    if (args[0] instanceof AudioDestinationNode && outputs.has(args[0])) args[0] = outputs.get(args[0])
    return disconnect.apply(this, args)
  }
}

const mutedContexts = new WeakSet()
async function silence(context) {
  if (mutedContexts.has(context)) return
  await context.addInitScript(silenceBrowserAudio)
  mutedContexts.add(context)
}

function silentBrowser(engine) {
  return {
    async launch(options) {
      const browser = await engine.launch(engine === chromiumEngine
        ? { ...options, args: [...(options?.args ?? []), '--mute-audio'] } : options)
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async options => {
        const context = await newContext(options)
        await silence(context)
        return context
      }
      const newPage = browser.newPage.bind(browser)
      browser.newPage = async options => {
        const page = await newPage(options)
        await silence(page.context())
        // Also cover tests using setContent/evaluate on the initial about:blank document.
        await page.evaluate(silenceBrowserAudio)
        return page
      }
      return browser
    },
  }
}

export const chromium = silentBrowser(chromiumEngine)
export const webkit = silentBrowser(webkitEngine)

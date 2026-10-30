import assert from 'node:assert/strict'
import { chromium, webkit } from './lib/silent-browser.mjs'
import { chromium as profiledChromium } from './lib/profile-browser.mjs'

for (const [name, engine] of [
  ['chromium', chromium], ['webkit', webkit], ['profiled-chromium', profiledChromium],
]) {
  if (process.argv.includes('--chromium-only') && name === 'webkit') continue
  if (process.argv.includes('--webkit-only') && name !== 'webkit') continue
  const browser = await engine.launch(name === 'webkit' ? undefined : { args: ['--enable-automation'] })
  try {
    if (name !== 'webkit') {
      const session = await browser.newBrowserCDPSession()
      const { arguments: args } = await session.send('Browser.getBrowserCommandLine')
      assert(args.includes('--mute-audio'), 'Chromium must have browser-level muting as well')
      await session.detach()
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.setContent('<button>Start</button><video></video>')
    const mediaMuted = await page.evaluate(() => {
      const audio = new Audio()
      audio.muted = false
      const video = document.querySelector('video')
      video.muted = false
      return audio.muted && video.muted
    })
    assert(mediaMuted, 'media must stay muted even when the test requests sound')
    await page.evaluate(() => {
      document.querySelector('button').onclick = async () => {
        const context = new AudioContext()
        const createGain = context.createGain.bind(context)
        const gains = []
        context.createGain = (...args) => {
          const gain = createGain(...args)
          gains.push(gain)
          return gain
        }
        const source = context.createOscillator()
        const original = context.createGain()
        original.gain.value = 0.5
        const before = context.createAnalyser()
        const after = context.createAnalyser()
        source.connect(original)
        original.connect(before)
        const destination = original.connect(context.destination)
        const output = gains.find(gain => gain !== original)
        // Never start a tone until the output gate has been verified silent.
        if (!output || output.gain.value !== 0) throw new Error('No silent output gate')
        before.connect(output)
        output.connect(after)
        source.start()
        await context.resume()
        window.audioProbe = { context, source, original, before, after,
          nativeDestination: destination === context.destination, output }
      }
    })
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.waitForFunction(() => {
      const probe = window.audioProbe
      if (!probe) return false
      const samples = new Float32Array(probe.before.fftSize)
      probe.before.getFloatTimeDomainData(samples)
      return samples.some(value => Math.abs(value) > 0.01)
    })
    const result = await page.evaluate(async () => {
      const { context, source, original, after, nativeDestination, output } = window.audioProbe
      const samples = new Float32Array(after.fftSize)
      after.getFloatTimeDomainData(samples)
      original.disconnect(context.destination)
      const result = { nativeDestination, originalGain: original.gain.value,
        outputGain: output.gain.value, silent: samples.every(value => value === 0) }
      source.stop()
      await context.close()
      const offline = new OfflineAudioContext(1, 128, 44100)
      const constant = offline.createConstantSource()
      constant.connect(offline.destination)
      constant.start()
      const rendered = await offline.startRendering()
      return { ...result, offlineIntact: rendered.getChannelData(0).some(value => value !== 0) }
    })
    assert.deepEqual(result, { nativeDestination: true, originalGain: 0.5,
      outputGain: 0, silent: true, offlineIntact: true })
    const context = await browser.newContext()
    await context.route('http://silent.test/**', route => route.fulfill({
      contentType: 'text/html', body: new URL(route.request().url()).pathname === '/frame'
        ? '<p>Child frame</p>' : '<iframe src="/frame"></iframe>',
    }))
    const separate = await context.newPage()
    assert(await separate.evaluate(() => new Audio().muted), 'explicit about:blank pages must already be muted')
    await separate.goto('http://silent.test/')
    assert(await separate.evaluate(() => new Audio().muted), 'explicit contexts must be muted before navigation')
    await separate.reload()
    assert(await separate.evaluate(() => new Audio().muted), 'reload must preserve muting')
    await separate.waitForFunction(() => document.querySelector('iframe').contentDocument?.readyState === 'complete')
    assert(await separate.frames()[1].evaluate(() => new Audio().muted), 'child frames must be muted')
    assert.equal(await separate.evaluate(() => localStorage.getItem('sts-profile') !== null), name === 'profiled-chromium',
      'silencing must not change fresh-profile registration behavior')
    await context.close()
    console.log(`PASS ${name}: silent media and Web Audio, intact audio logic, navigation and profile isolation`)
  } finally {
    await browser.close()
  }
}

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const out=resolve('artifacts/blessing-potions')
mkdirSync(out,{recursive:true})
const server=await createServer({logLevel:'silent',server:{port:0}})
await server.listen()
const browser=await chromium.launch()
try {
  for(const [screen,viewport] of [['desktop',{width:1440,height:900}],['horizontal-phone',{width:844,height:390}]]) {
    const context=await browser.newContext({viewport,hasTouch:screen==='horizontal-phone',isMobile:screen==='horizontal-phone'})
    const page=await context.newPage()
    const errors=[]
    page.on('pageerror',e=>errors.push(String(e)))
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(async()=>{
      document.querySelector('#root').remove()
      const node=document.createElement('div');node.className='app-shell sts-scope';document.body.append(node)
      const [R,D,{NeowScreen},{createPlayer},{createRng},{NEOW_CARDS,HEARTS_BOON_CARDS}]=await Promise.all([
        import('/@id/react'),import('/@id/react-dom/client'),import('/src/ui/NeowScreen.tsx'),
        import('/src/game/run.ts'),import('/src/game/rng.ts'),import('/src/game/neow.ts'),
        import('/src/ui/styles.css'),import('/src/ui/chrome.css'),
      ])
      const root=(D.createRoot??D.default.createRoot)(node), rng=createRng(47)
      const players=[createPlayer(rng,'p1','Hero','ironclad',0),createPlayer(rng,'p2','Friend','silent',0)]
      const f=window.fixture={players,enabled:true,choices:[]}
      f.install=(heart=false,held=[],blocked=false,empty=false)=>{
        players[0].potions=held;players[0].relics=blocked?[{defId:'sozu'}]:[];players[1].potions=[]
        const card=(heart?HEARTS_BOON_CARDS:NEOW_CARDS).find(c=>c.options.some(o=>o.effects.some(e=>e.kind==='potions'&&e.count===3)))
        if(!card)throw Error('Missing three-potion blessing')
        f.progress={p1:{card,redGoldPending:false,redRewardPending:false,redReward:null,blueOption:0,
          rewardKind:'potion',reward:{kind:'potion',choices:empty?[]:['weak_potion'],cardsDrawn:[],raresDrawn:[]},
          rewardQueue:['potion','potion'],pendingEffect:null,done:false}}
        f.choices=[];f.enabled=true;f.render()
      }
      f.render=()=>root.render((R.createElement??R.default.createElement)(NeowScreen,{players,progress:f.progress,viewerId:'p1',ascension:0,
        enabled:f.enabled,onGold:()=>{},onReveal:()=>{},onEffect:()=>{},onChoose:()=>{},
        onReward:(_id,choice,stage)=>{f.choices.push({choice,stage})}}))
      f.install()
    })
    const loot=page.locator('.reward-screen--loot')
    const choose=async(name,decision)=>{
      const previous=await page.evaluate(()=>window.fixture.choices.length)
      const button=page.getByRole('button',{name,exact:true})
      if(screen==='horizontal-phone' && name!=='Skip') {
        await button.tap()
        assert.equal(await page.evaluate(()=>window.fixture.choices.length),previous,'first tap must show potion details')
        await button.tap()
      } else await button.click()
      await page.waitForFunction(n=>window.fixture.choices.length===n+1,previous)
      assert.deepEqual(await page.evaluate(()=>window.fixture.choices.at(-1)),{choice:decision,stage:'reward'})
    }
    for(const heart of [false,true]) {
      await page.evaluate(h=>window.fixture.install(h),heart)
      await loot.waitFor()
      await page.evaluate(()=>document.fonts.ready)
      await page.waitForTimeout(350)
      assert.equal(await page.locator('.reward-screen__title').textContent(),'Blessing')
      const art=await loot.evaluate(e=>({scroll:getComputedStyle(e.querySelector('h2'),'::before').backgroundImage,
        stone:getComputedStyle(e.querySelector('.reward-screen__players')).backgroundImage}))
      assert(art.scroll.includes('loot-scroll.svg')&&art.stone.includes('loot-stone.svg'))
      const visible=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
      for(const selector of ['.reward-screen__title','.reward-screen__players','.reward-screen__skip']) {
        const rect=await page.locator(selector).boundingBox()
        assert(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=visible.width+1&&rect.y+rect.height<=visible.height+1,`${screen}: ${selector} clipped`)
      }
      await page.screenshot({path:resolve(out,`${screen}-${heart?'heart':'neow'}.png`)})
      await choose('Weak Potion',{kind:'gain'})
      await choose('Pass Weak Potion to Friend',{kind:'pass',playerId:'p2'})
      await choose('Skip',{kind:'skip'})
    }
    await page.evaluate(()=>window.fixture.install(false,['fire_potion']))
    await choose('Weak Potion — replace Fire Potion',{kind:'replace',potionId:'fire_potion'})
    await page.evaluate(()=>{window.fixture.enabled=false;window.fixture.render()})
    await page.getByRole('status').filter({hasText:'Reconnecting'}).waitFor()
    assert.equal(await loot.locator('button:enabled').count(),0)
    await page.evaluate(()=>window.fixture.install(false,[],true))
    assert(await page.getByRole('button',{name:'Weak Potion',exact:true}).isDisabled())
    await choose('Pass Weak Potion to Friend',{kind:'pass',playerId:'p2'})
    await page.evaluate(()=>window.fixture.install(false,[],false,true))
    await page.getByText('No Potion remains in the supply.').waitFor()
    await choose('Skip',{kind:'skip'})
    assert.deepEqual(errors,[])
    await context.close()
    console.log(`PASS ${screen}: Neow/Heart parchment and stone, gain/replace/pass/skip, Sozu, reconnect, empty supply`)
  }
} finally {await browser.close();await server.close()}

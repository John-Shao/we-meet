// Real Electron -> native monitor mapping probe. Does not request control or
// inject input. Run with the project's Electron binary after build:main/native.
const { app, screen, desktopCapturer } = require('electron')
const { RemoteInputHelper } = require('../dist/remote-control/native-helper.js')
const { bindScreenSource } = require('../dist/remote-control/source-binding.js')
const path = require('node:path')
const fs = require('node:fs')

function wait(helper, name) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{helper.off('state',listener);reject(Error(`Timeout: ${name}`))},5000)
    const listener=event=>{if(event.event===name){clearTimeout(timer);helper.off('state',listener);resolve(event)}}
    helper.on('state',listener)
  })
}
app.whenReady().then(async()=>{
  const helper=new RemoteInputHelper()
  let code=0
  try {
    await helper.start(path.join(__dirname,'../dist/remote-input'))
    const native=wait(helper,'displays');helper.listDisplays()
    const nativeDisplays=(await native).displays
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}})
    const displays=screen.getAllDisplays()
    if(!sources.length)throw Error('No screen sources available')
    const results=sources.map(source=>{
      const binding=bindScreenSource(source,displays,nativeDisplays,rect=>screen.dipToScreenRect(null,rect))
      const {left,top,width,height,dpiX,dpiY,rotation}=binding.native
      return {sourceId:binding.sourceId,electronDisplayId:binding.electronDisplayId,dipBounds:binding.dipBounds,
        scaleMilli:binding.scaleMilli,physical:{left,top,width,height,dpiX,dpiY,rotation},hash:binding.displayBindingHash}
    })
    const report={electron:process.versions.electron,platform:process.platform,results}
    fs.writeFileSync(path.join(__dirname,'../dist/remote-input/display-probe.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report))
  } catch(error) {code=1;console.error(error.message)}
  finally {
    const stopped=wait(helper,'terminated');helper.stop()
    try {if((await stopped).cleanup!==1)throw Error('Native cleanup was not confirmed')}catch(error){code=1;console.error(error.message)}
    app.exit(code)
  }
})

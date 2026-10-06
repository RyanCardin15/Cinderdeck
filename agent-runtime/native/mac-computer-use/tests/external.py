# Tests only its own temporary AppKit app and fictional data. Never uses the clipboard.
import pathlib, plistlib, shutil, subprocess, json, time, statistics, select, sys
root=pathlib.Path(sys.argv[3])
app=root/'Computer Use Fixture.app'
mac=app/'Contents/MacOS'
mac.mkdir(parents=True,exist_ok=True)
shutil.copy2(sys.argv[1],mac/'fixture')
with (app/'Contents/Info.plist').open('wb') as f:
 plistlib.dump({'CFBundleIdentifier':'com.example.computer-use-fixture','CFBundleExecutable':'fixture','CFBundleName':'Computer Use Fixture','CFBundlePackageType':'APPL','LSUIElement':True},f)
subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(app)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
helper=sys.argv[2]
fixture=None; native=None

def read(p,timeout=35):
 ready,_,_=select.select([p.stdout],[],[],timeout)
 if not ready: raise TimeoutError('Owned fixture/helper did not respond')
 line=p.stdout.readline()
 if not line: raise RuntimeError('Owned process exited')
 return json.loads(line)

try:
 fixture=subprocess.Popen([str(mac/'fixture'),'--target'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 print('fixture',read(fixture),flush=True)
 native=subprocess.Popen([helper,'--serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 print('helper',read(native),flush=True)
 sequence=0
 def call(method,**params):
  global sequence
  sequence+=1;start=time.perf_counter()
  params.setdefault('app','com.example.computer-use-fixture');params.setdefault('agent',{'id':'fixture-agent','label':'Fixture test'})
  native.stdin.write(json.dumps({'id':sequence,'method':method,'params':params})+'\n');native.stdin.flush()
  result=read(native)
  assert result.get('id')==sequence,result
  if 'error' in result: raise RuntimeError(result)
  return result['result'],(time.perf_counter()-start)*1000
 def state(image=False):return call('getState',includeScreenshot=image)
 first,ms=state(True)
 print('initial',json.dumps({'ms':ms,'windows':first['windows'],'nodes':len(first['nodes']),'screenshot': {k:v for k,v in first.get('screenshot',{}).items() if k!='data'},'screenshotError':first.get('screenshotError')}),flush=True)
 assert first.get('screenshot',{}).get('data'),first.get('screenshotError')
 field=next(n for n in first['nodes'] if n.get('identifier')=='fixture-field');idx=field['id']
 def value(s):return next(n.get('value','') for n in s['nodes'] if n.get('identifier')=='fixture-field')
 call('setValue',id=idx,value='hello 🐟 world')
 call('selectText',id=idx,text='🐟',prefix='hello ',suffix=' world',mode='text')
 after,_=state()
 assert value(after)=='hello 🐟 world',after
 assert after.get('selectedText')=='🐟',after
 call('type',id=idx,text='native keyboard')
 time.sleep(.2)
 after,_=state();print('Background Unicode typing verified',flush=True)
 assert value(after)=='hello native keyboard world',value(after)
 call('key',keyCode=0,modifiers=['command'])
 key_state,_=state();assert key_state.get('selectedText') == 'hello native keyboard world'
 call('type',text='background replacement')
 time.sleep(.2)
 after,_=state();assert value(after)=='background replacement',value(after)
 # Click the field by its accessibility index, which falls back to targeted mouse events.
 call('click',id=idx,button='left',count=1)
 call('key',keyCode=0,modifiers=['command'])
 call('type',text='pointer verified')
 time.sleep(.2)
 after,_=state();assert value(after)=='pointer verified',value(after)
 # Plain typing must not inherit Control from the preceding key chord.
 call('key',keyCode=14,modifiers=['control'])
 call('type',text='!')
 time.sleep(.2)
 after,_=state();assert value(after)=='pointer verified!',value(after)
 # Another conversation's window selection must not alter this agent's target.
 other,_=call('getState',includeScreenshot=False,window=1,agent={'id':'other-fixture-agent','label':'Other fixture'})
 assert value(other)=='fixture only'
 after,_=state();assert value(after)=='pointer verified!'
 durations=[]
 for i in range(20):
  after,ms=state();durations.append(ms)
  assert value(after)=='pointer verified!'
 shot,shotms=state(True)
 assert shot.get('screenshot',{}).get('data')
 (root/'fixture-screenshot.jpg').write_bytes(__import__('base64').b64decode(shot['screenshot']['data']))
 print(json.dumps({'ok':True,'checks':['separate-app accessibility','window screenshot','direct value','Unicode selection','background typing','Command-A chord','background click','modifier clearing','conversation window isolation','repeat reads'],'readMedianMs':statistics.median(durations),'readP95Ms':sorted(durations)[19],'screenshotStateMs':shotms,'screenshotBytes':len(shot['screenshot']['data'])}),flush=True)
finally:
 if native:
  native.stdin.close()
  try:native.wait(timeout=5)
  except subprocess.TimeoutExpired:native.terminate();native.wait(timeout=5)
 if fixture:
  fixture.terminate();fixture.wait(timeout=5)

// be2boost | מאמן שיחות מכירה. שרת ללא תלויות חיצוניות (Node 18+).
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const {SYS}=require('./prompt');
const PORT=process.env.PORT||3000;
const PW=process.env.APP_PASSWORD, AKEY=process.env.ANTHROPIC_API_KEY, OKEY=process.env.OPENAI_API_KEY;
const MODEL=process.env.CLAUDE_MODEL||'claude-sonnet-5-5';
const TMODEL=process.env.TRANSCRIBE_MODEL||'whisper-1';
const MAX_BYTES=24*1024*1024; // מגבלת שירות התמלול: 25MB
if(!PW||!AKEY||!OKEY){console.error('חסרים משתני סביבה: APP_PASSWORD, ANTHROPIC_API_KEY, OPENAI_API_KEY');process.exit(1)}
const jobs=new Map();
setInterval(()=>{const t=Date.now();for(const[k,v]of jobs)if(t-v.t>30*60*1000)jobs.delete(k)},60000).unref();

const authOk=req=>{const a=Buffer.from(String(req.headers['x-app-password']||'')),b=Buffer.from(PW);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const send=(res,code,obj)=>{if(res.headersSent){res.end();return}res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj))};
const readBody=(req,max)=>new Promise((ok,no)=>{const c=[];let n=0;req.on('data',d=>{n+=d.length;if(n>max){no(new Error('too_large'));req.destroy();return}c.push(d)});req.on('end',()=>ok(Buffer.concat(c)));req.on('error',no)});

async function transcribe(buf,name,mime){
  const fd=new FormData();
  fd.append('file',new Blob([buf],{type:mime}),name);
  fd.append('model',TMODEL);fd.append('language','he');fd.append('response_format','json');
  const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+OKEY},body:fd});
  if(!r.ok)throw new Error('transcribe_failed_'+r.status);
  const j=await r.json();return j.text||'';
}
async function analyze(transcript,type){
  const user='סוג השיחה: '+type+'\n\nהערה: התמלול אוטומטי וללא סימון דוברים. הסק מההקשר מי הנציגה ומי הלקוחה, וציין זאת בשדה assumptions.\n\nתמלול:\n'+transcript חשוב: בתוך ערכי המחרוזות ב-JSON אל תשתמש בתו מרכאות כפולות; כתוב ציטוטים בתוך ״ ״ (מרכאות עבריות) או בגרשיים. החזר JSON תקין בלבד.;
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'x-api-key':AKEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:MODEL,max_tokens:6000,system:SYS,messages:[{role:'user',content:user}]})});
  if(!r.ok)throw new Error('analyze_failed_'+r.status);
  const j=await r.json();const t=(j.content||[]).map(c=>c.text||'').join('');
  const s=t.indexOf('{'),e=t.lastIndexOf('}');if(s<0||e<0)throw new Error('bad_json');
  return JSON.parse(t.slice(s,e+1));
}
async function run(id,buf,name,mime,type,isText){
  const job=jobs.get(id);
  try{
    let tr;
    if(isText)tr=buf.toString('utf8');
    else{job.status='transcribing';tr=await transcribe(buf,name,mime)}
    if(tr.trim().length<200)throw new Error('short');
    job.transcript=tr;job.status='analyzing';
    job.result=await analyze(tr,type).catch(()=>analyze(tr,type));;job.status='done';
  }catch(e){job.status='error';job.error=e.message}
}
const MIME={'.html':'text/html; charset=utf-8','.jpg':'image/jpeg'};
http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x');
    if(u.pathname==='/health')return send(res,200,{ok:true});
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){let page;try{page=fs.existsSync(path.join(__dirname,'public','index.html'))?fs.readFileSync(path.join(__dirname,'public','index.html')):fs.readFileSync(path.join(__dirname,'index.html'))}catch(e){console.error('חסר הקובץ public/index.html במאגר');return send(res,500,{error:'missing_index'})}res.writeHead(200,{'content-type':MIME['.html']});return res.end(page)}
    if(!u.pathname.startsWith('/api/'))return send(res,404,{error:'not_found'});
    if(!authOk(req))return send(res,401,{error:'unauthorized'});
    if(u.pathname==='/api/check')return send(res,200,{ok:true});
    if(req.method==='POST'&&u.pathname==='/api/jobs'){
      if([...jobs.values()].filter(j=>j.status==='transcribing'||j.status==='analyzing'||j.status==='queued').length>=5)return send(res,429,{error:'busy'});
      const mime=String(req.headers['content-type']||'application/octet-stream').split(';')[0];
      const isText=mime==='text/plain';
      let buf;try{buf=await readBody(req,isText?500000:MAX_BYTES)}catch(e){return send(res,413,{error:'too_large'})}
      const id=crypto.randomUUID();
      jobs.set(id,{t:Date.now(),status:'queued'});
      const type=decodeURIComponent(String(req.headers['x-call-type']||'שיחת מכירה'));
      const name=decodeURIComponent(String(req.headers['x-filename']||'call.mp3'));
      run(id,buf,name,mime,type,isText);
      return send(res,202,{id});
    }
    const m=u.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if(req.method==='GET'&&m){const j=jobs.get(m[1]);if(!j)return send(res,404,{error:'not_found'});return send(res,200,{status:j.status,error:j.error,result:j.result,transcript:j.transcript})}
    send(res,404,{error:'not_found'});
  }catch(e){send(res,500,{error:'server'})}
}).listen(PORT,()=>console.log('be2boost coach on '+PORT));
process.on('unhandledRejection',e=>console.error('unhandled',e&&e.message));process.on('uncaughtException',e=>console.error('uncaught',e&&e.message));

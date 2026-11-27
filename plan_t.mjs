process.env.AUTH_SECRET='x'.repeat(40);process.env.BLOB_READ_WRITE_TOKEN='t';process.env.DATABASE_URL='postgres://postgres@127.0.0.1:5433/craftifix';process.env.STRIPE_SECRET_KEY='sk_test_'+'a'.repeat(30);
const of=globalThis.fetch; globalThis.fetch=async(u,o)=>{const s=String(u); if(!s.startsWith('https://blob.local/')) return new Response('{}',{status:200}); return of(u,o)};
await import('@vercel/blob');
const account=(await import('/tmp/ct/api/account.js')).default; const L=await import('/tmp/ct/api/_lib.js');
let cookie='';
function call(h,{method='GET',query={},body=null}){return new Promise(res=>{const r={statusCode:200,setHeader(k,v){if(k.toLowerCase()==='set-cookie')cookie=String(v).split(';')[0]},status(c){this.statusCode=c;return this},json(b){res({code:this.statusCode,body:b});return this},end(b){res({code:this.statusCode,body:b})}};
 Promise.resolve(h({method,query,body,headers:{host:'x.test',cookie,'content-type':'application/json'}},r)).catch(e=>res({code:'THROW',body:String(e.stack)}))})}
const ok=(c,m,x)=>{if(!c){console.error('FAIL',m,JSON.stringify(x).slice(0,400));process.exit(1)}console.log('ok',m)};
let r=await call(account,{method:'POST',query:{action:'signup'},body:{userId:'trialshop',password:'pass1234',name:'T',business:'Trial Shop',email:'t@x.com',whatsapp:'+971501112233',shopAddress:'Building 1, Street 2, Al Nahda, Sharjah',currency:'AED',shopLat:25.3,shopLng:55.4}});
ok(r.code===201,'sign-up works with no plan sent',r);
let u=await L.getUser('trialshop'); ok(u.plan==='premium'&&u.subscription.status==='trial'&&u.subscription.planChosen===false,'trial starts on Premium (all features), plan not chosen',u.subscription);
r=await call(account,{method:'POST',query:{action:'plan'},body:{plan:'premium'}}); ok(r.code===200&&r.body.user.subscription.planChosen===true&&r.body.user.plan==='premium','choosing the plan it is already on records the choice',r);
r=await call(account,{method:'POST',query:{action:'plan'},body:{plan:'standard'}}); ok(r.code===200&&r.body.user.plan==='standard','switch to Standard during trial',r);
u=await L.getUser('trialshop'); ok(u.subscription.trialEndsAt&&u.subscription.status==='trial','trial dates unchanged',u.subscription);
console.log('sheet plan:',L.accountForSheet({...u,subscription:{...u.subscription,planChosen:false}}).plan);
console.log('PLAN TESTS PASSED');process.exit(0);

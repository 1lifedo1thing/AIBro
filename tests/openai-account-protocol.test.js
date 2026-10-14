'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const p=require('../app/openai-account-protocol');
const host='urn:uuid:ca65a8aa-5ee5-4271-812e-34c189732976',clientId='oaiapp_synthetic',subject='synthetic-subject',now=1800000000000;
const redirectUri='http://127.0.0.1:1455/auth/callback';
const create=overrides=>p.createAuthorization({redirectUri,host,cryptoProvider:webcrypto,now,...overrides});
const callback=(attempt,values={})=>redirectUri+'?'+new URLSearchParams({state:new URL(attempt.authorizationURL).searchParams.get('state'),code:'synthetic-code',client_id:clientId,...values});
const discovery={issuer:p.ISSUER,authorization_endpoint:p.AUTHORIZE,token_endpoint:p.TOKEN,jwks_uri:p.JWKS,id_token_signing_alg_values_supported:['RS256'],revocation_endpoint:p.ISSUER+'/synthetic-revoke'};
const jwks={keys:[{kid:'synthetic-rsa',kty:'RSA',n:'synthetic-public-n',e:'AQAB',alg:'RS256'}]};
const expected={issuer:p.ISSUER,clientId,nonce:'synthetic-nonce',subject};
const claims=()=>({iss:p.ISSUER,aud:clientId,sub:subject,nonce:expected.nonce,iat:now/1000,exp:now/1000+3600,email:'same@example.test'});
async function verified(payload=claims(),extra={}){
  const calls=[];
  const result=await p.verifyIDToken('synthetic.signed.token',{expected,discovery,jwks,nowSeconds:now/1000,
    createLocalJWKSet:keys=>{assert.deepEqual(keys,jwks);return 'synthetic-jose-keyset';},
    jwtVerify:async(token,key,options)=>{calls.push({token,key,options});return {payload,protectedHeader:{alg:'RS256'}};},...extra});
  return {result,calls};
}
const fence=()=>({hostId:host,clientId,issuer:p.ISSUER,subject,sessionId:'synthetic-session',generation:1,credentialRevision:2});
const response=()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic.signed.token',token_type:'Bearer',expires_in:3600,scope:p.SCOPES});
test('PKCE uses the published S256 construction and every attempt has fresh independent proofs',async()=>{
  assert.equal(await p.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',webcrypto),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a=await create(),b=await create(),qa=new URL(a.authorizationURL).searchParams,qb=new URL(b.authorizationURL).searchParams;
  for(const key of ['state','nonce','code_challenge']){assert.match(qa.get(key),/^[\w-]{43}$/);assert.notEqual(qa.get(key),qb.get(key));}
  assert.equal(qa.get('client_id'),'dynamic_agent_client');assert.equal(qa.get('agent_name_hint'),'AI Bro');assert.equal(qa.get('resource'),p.RESOURCE);
  const result=a.consumeCallback(callback(a),now+1),body=new URLSearchParams(result.request.body);
  assert.equal(body.get('client_id'),clientId);assert.equal(body.get('redirect_uri'),redirectUri);assert.equal(body.has('client_secret'),false);
  assert.equal(await p.pkceChallenge(body.get('code_verifier'),webcrypto),qa.get('code_challenge'));
});
test('wrong state cannot consume a legitimate attempt; correct callback succeeds exactly once',async()=>{
  const a=await create();assert.throws(()=>a.consumeCallback(callback(a,{state:'wrong'}),now+1),{code:'STATE_MISMATCH'});
  assert.equal(a.consumeCallback(callback(a),now+2).status,'code');assert.throws(()=>a.consumeCallback(callback(a),now+3),{code:'CALLBACK_CONSUMED'});
});
test('matching-state OAuth denial consumes the attempt without reflecting its description',async()=>{
  const a=await create(),url=new URL(callback(a));url.searchParams.delete('code');url.searchParams.set('error','access_denied');url.searchParams.set('error_description','synthetic-sensitive-description');
  assert.deepEqual(a.consumeCallback(url.href,now+1),{status:'error',code:'ACCESS_DENIED'});assert.throws(()=>a.consumeCallback(callback(a),now+2),{code:'CALLBACK_CONSUMED'});
});
test('callback duplicates, missing issued ID, wrong path and dynamic ID cannot become a registration',async()=>{
  for(const change of [u=>u.searchParams.append('code','second'),u=>u.searchParams.delete('client_id'),u=>u.searchParams.set('client_id','dynamic_agent_client')]){
    const a=await create(),url=new URL(callback(a));change(url);assert.throws(()=>a.consumeCallback(url.href,now+1));assert.throws(()=>a.consumeCallback(callback(a),now+2),{code:'CALLBACK_CONSUMED'});
  }
  const a=await create();assert.throws(()=>a.consumeCallback(callback(a).replace('/auth/callback','/callback'),now+1),{code:'INVALID_CALLBACK'});assert.equal(a.consumeCallback(callback(a),now+2).status,'code');
});
test('callback expires or cancels and is strictly loopback; reauthorization only varies the port',async()=>{
  for(const uri of ['aibro://oauth/callback','http://localhost:1455/auth/callback','https://127.0.0.1:1455/auth/callback','http://127.0.0.1:1455/auth/callback?x=1'])await assert.rejects(create({redirectUri:uri}),{code:'INVALID_CALLBACK'});
  const a=await create();assert.throws(()=>a.consumeCallback(callback(a),now+600000),{code:'CALLBACK_EXPIRED'});
  const b=await create();b.cancel();assert.throws(()=>b.consumeCallback(callback(b),now+1),{code:'CALLBACK_CONSUMED'});
  const registration={issuer:p.ISSUER,clientId,subject,redirectUri,idTokenHint:'retained.signed.hint',email:'same@example.test'};
  const c=await create({registration,redirectUri:redirectUri.replace('1455','54321')}),url=new URL(c.authorizationURL);assert.equal(url.searchParams.get('client_id'),clientId);assert.equal(url.searchParams.has('agent_name_hint'),false);
  assert.equal(url.searchParams.get('id_token_hint'),'retained.signed.hint');await assert.rejects(create({registration,redirectUri:'http://127.0.0.1:1455/callback'}),{code:'INVALID_CALLBACK'});
});
test('returning callback retains its registration and refuses a different client',async()=>{
  const registration={issuer:p.ISSUER,clientId,subject,redirectUri};
  const a=await create({registration}),url=new URL(callback(a));url.searchParams.delete('client_id');assert.equal(a.consumeCallback(url.href,now+1).clientId,clientId);
  const b=await create({registration});assert.throws(()=>b.consumeCallback(callback(b,{client_id:'other-client'}),now+1),{code:'CLIENT_MISMATCH'});
  const c=await create({registration});assert.throws(()=>c.consumeCallback(callback(c,{client_id:''}),now+1));
});
test('discovery and public JWKS cannot redirect verification or contain a private key',()=>{
  assert.equal(p.validateDiscovery(discovery).jwksURI,p.JWKS);
  for(const patch of [{issuer:'https://evil.test'},{jwks_uri:'https://evil.test/keys'},{token_endpoint:'https://evil.test/token'},{id_token_signing_alg_values_supported:['none','HS256']},{revocation_endpoint:'https://evil.test/revoke'}])assert.throws(()=>p.validateDiscovery({...discovery,...patch}));
  for(const keys of [[{...jwks.keys[0],d:'private'}],[jwks.keys[0],jwks.keys[0]],[{kid:'symmetric',kty:'oct',k:'secret'}]])assert.throws(()=>p.validateJWKS({keys}));
});
test('ID-token validation invokes JOSE with issuer, audience, algorithms and bounded time skew',async()=>{
  const {result,calls}=await verified();assert.equal(result.subject,subject);assert.equal(calls.length,1);
  const options=calls[0].options;assert.equal(options.issuer,p.ISSUER);assert.equal(options.audience,clientId);assert.deepEqual(options.algorithms,['RS256']);assert.deepEqual(options.requiredClaims,['sub','exp','iat']);assert.equal(options.clockTolerance,5);
  await assert.rejects(verified(claims(),{jwtVerify:async()=>{throw Error('signature failure with a synthetic secret');}}),{code:'INVALID_ID_TOKEN',message:'OpenAI account protocol validation failed.'});
});
test('issuer, audience, nonce, expiry and same-registration subject are independently required',async()=>{
  for(const patch of [{iss:'https://evil.test'},{aud:'other-client'},{nonce:'other-nonce'},{exp:now/1000-10},{iat:now/1000+10},{nbf:now/1000+10},{sub:'other-subject'},{sub:''},{exp:'1800003600'}])await assert.rejects(verified({...claims(),...patch}),{code:'INVALID_ID_TOKEN'});
});
test('multiple audiences require exact azp; same email does not link another subject',async()=>{
  await assert.rejects(verified({...claims(),aud:[clientId,'other']}));await assert.rejects(verified({...claims(),aud:[clientId,'other'],azp:'other'}));
  assert.equal((await verified({...claims(),aud:[clientId,'other'],azp:clientId})).result.subject,subject);
  await assert.rejects(verified({...claims(),sub:'different',email:'same@example.test'}));
  const renewed=claims();delete renewed.nonce;assert.equal((await verified(renewed,{refresh:true})).result.subject,subject);
  await assert.rejects(verified(renewed,{refresh:'yes'}));
});
test('code-exchange proposal requires proof for that exact ID token and scopes control plan use',async()=>{
  const identity=(await verified()).result;
  const good=p.tokenProposal({response:response(),verifiedIdentity:identity,expectedSession:fence(),receivedAt:now});assert.equal(good.planUsageEnabled,true);
  assert.equal(good.credentials.expiresAt,now+3600000);assert.equal(good.credentials.refreshToken,'synthetic-refresh');
  assert.throws(()=>p.tokenProposal({response:response(),verifiedIdentity:{...identity},expectedSession:fence(),receivedAt:now}),{code:'INVALID_ID_TOKEN'});
  assert.throws(()=>p.tokenProposal({response:{...response(),id_token:'different.signed.token'},verifiedIdentity:identity,expectedSession:fence(),receivedAt:now}),{code:'INVALID_ID_TOKEN'});
  const identityOnly={...response(),scope:'openid profile email'};delete identityOnly.refresh_token;
  const limited=p.tokenProposal({response:identityOnly,verifiedIdentity:identity,expectedSession:fence(),receivedAt:now});assert.equal(limited.planUsageEnabled,false);assert.equal(limited.credentials.refreshToken,null);
});
test('refresh request uses the issued client and omits scope; response replaces the whole token set',async()=>{
  const req=p.refreshRequest({clientId,refreshToken:'old-refresh'}),body=new URLSearchParams(req.body);assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.has('scope'),false);assert.equal(body.has('ext_agent_host_id'),false);
  assert.throws(()=>p.refreshRequest({clientId:'dynamic_agent_client',refreshToken:'old'}));
  const identity=(await verified()).result,old=p.tokenProposal({response:response(),verifiedIdentity:identity,expectedSession:fence(),receivedAt:now}).credentials;
  const next={...response(),access_token:'new-access',refresh_token:'new-refresh'};delete next.id_token;
  const proposal=p.tokenProposal({response:next,verifiedIdentity:identity,expectedSession:fence(),previous:old,receivedAt:now+1000});
  assert.equal(proposal.credentials.accessToken,'new-access');assert.equal(proposal.credentials.refreshToken,'new-refresh');assert.equal(proposal.credentials.idToken,old.idToken);assert.equal(old.accessToken,'synthetic-access');
  const oldSnapshot=JSON.stringify(old),noScope={...next};delete noScope.scope;
  assert.throws(()=>p.tokenProposal({response:noScope,verifiedIdentity:identity,expectedSession:fence(),previous:old,receivedAt:now+1000}),{code:'INVALID_SCOPES'});
  delete next.refresh_token;assert.throws(()=>p.tokenProposal({response:next,verifiedIdentity:identity,expectedSession:fence(),previous:old,receivedAt:now+1000}));
  assert.equal(JSON.stringify(old),oldSnapshot);
});
test('late token proposals refuse a switched session, host, generation or credential revision',async()=>{
  const proposal=p.tokenProposal({response:response(),verifiedIdentity:(await verified()).result,expectedSession:fence(),receivedAt:now});assert.equal(p.assertProposalSession(proposal,fence()),true);
  for(const patch of [{clientId:'other-client'},{subject:'other-subject'},{sessionId:'other-session'},{generation:2},{credentialRevision:3},{hostId:'urn:uuid:00000000-0000-4000-8000-000000000000'}])assert.throws(()=>p.assertProposalSession(proposal,{...fence(),...patch}),{code:'STALE_SESSION'});
});
test('malformed token shape never produces a credential proposal or logs its values',async()=>{
  const identity=(await verified()).result;
  for(const patch of [{token_type:'Basic'},{expires_in:0},{expires_in:true},{scope:undefined},{scope:'openid\nchatgpt.tokens.use.direct'},{access_token:'synthetic\nsecret'},{refresh_token:''}]){
    assert.throws(()=>p.tokenProposal({response:{...response(),...patch},verifiedIdentity:identity,expectedSession:fence(),receivedAt:now}),error=>error instanceof p.ProtocolError&&!error.message.includes('synthetic'));
  }
});

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { db } from './db.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 168);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'100kb'}));
app.use(cookieParser());
app.use(express.static('public'));

const now = ()=>new Date().toISOString();
const audit=(actor,action,type,id,details={})=>db.prepare('INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,details_json) VALUES(?,?,?,?,?)').run(actor?.id||null,action,type,String(id??''),JSON.stringify(details));
const ownerCount=()=>db.prepare("SELECT COUNT(*) c FROM users WHERE role='OWNER'").get().c;
const userById=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
const currentSeason=()=>db.prepare("SELECT * FROM seasons WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1").get();
function publicUser(u){return {id:u.id,icName:u.ic_name,totalPoints:u.total_points,status:u.status};}
function auth(req,res,next){
 const t=req.cookies.rnx_session;
 if(!t) return res.status(401).json({error:'LOGIN_REQUIRED'});
 const s=db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(t,now());
 if(!s) return res.status(401).json({error:'SESSION_EXPIRED'});
 const u=userById(s.user_id);
 if(!u||u.status!=='ACTIVE') return res.status(403).json({error:'ACCOUNT_BLOCKED'});
 req.user=u; next();
}
function owner(req,res,next){if(req.user.role!=='OWNER') return res.status(403).json({error:'OWNER_ONLY'});next();}
function loginSession(res,user){
 const token=nanoid(48), expires=new Date(Date.now()+SESSION_HOURS*3600000).toISOString();
 db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token,user.id,expires);
 res.cookie('rnx_session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',expires:new Date(expires),path:'/'});
}
function addPoints(userId,amount,reason,ownerId,source='AUTO'){
 db.prepare('UPDATE users SET total_points=total_points+?,updated_at=? WHERE id=?').run(amount,now(),userId);
 db.prepare('INSERT INTO point_changes(user_id,amount,reason,owner_id,source) VALUES(?,?,?,?,?)').run(userId,amount,reason,ownerId,source);
}
function checkpointPoints(place){return place===1?10:place===2?5:place===3?2.5:0}
function goalPoints(place){return place===1?15:place===2?10:place===3?5:0}
function recomputeCheckpointPoints(raceId,checkpointId){
 const rows=db.prepare(`SELECT id,user_id FROM checkpoint_passes WHERE race_id=? AND checkpoint_id=? AND status IN ('PENDING','APPROVED','CORRECTED') ORDER BY confirmed_at ASC,id ASC`).all(raceId,checkpointId);
 const upd=db.prepare('UPDATE checkpoint_passes SET points_awarded=? WHERE id=?');
 const zero=db.prepare('SELECT user_id,points_awarded FROM checkpoint_passes WHERE id=?').get;
 for(let i=0;i<rows.length;i++){
   const p=checkpointPoints(i+1); const old=zero(rows[i].id)?.points_awarded||0;
   if(old!==p){const cp=db.prepare('SELECT name FROM checkpoints WHERE id=?').get(checkpointId); addPoints(rows[i].user_id,p-old,`Checkpoint ${cp.name} Platz ${i+1}`,null,'CHECKPOINT');}
   upd.run(p,rows[i].id);
 }
}
function rankGoals(raceId){
 const rows=db.prepare('SELECT id,user_id FROM goals WHERE race_id=? ORDER BY finished_at ASC,id ASC').all(raceId);
 const up=db.prepare('UPDATE goals SET placement=?,points_awarded=? WHERE id=?');
 for(let i=0;i<rows.length;i++){
   const place=i+1,p=goalPoints(place); const old=db.prepare('SELECT points_awarded FROM goals WHERE id=?').get(rows[i].id).points_awarded||0;
   if(old!==p)addPoints(rows[i].user_id,p-old,`Goal Platz ${place}`,null,'GOAL');
   up.run(place,p,rows[i].id);
 }
}

app.get('/api/auth/me',(req,res)=>{const t=req.cookies.rnx_session; if(!t)return res.json({user:null});const s=db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(t,now());if(!s)return res.json({user:null});const u=userById(s.user_id);res.json({user:u?{...publicUser(u),role:u.role}:null})});
app.post('/api/auth/login',(req,res)=>{const {icName,password}=req.body||{};const u=db.prepare('SELECT * FROM users WHERE ic_name=?').get(String(icName||''));if(!u||u.status!=='ACTIVE'||!bcrypt.compareSync(String(password||''),u.password_hash))return res.status(401).json({error:'INVALID_LOGIN'});loginSession(res,u);audit(u,'LOGIN','USER',u.id);res.json({user:{...publicUser(u),role:u.role}})});
app.post('/api/auth/logout',auth,(req,res)=>{db.prepare('DELETE FROM sessions WHERE token=?').run(req.cookies.rnx_session);res.clearCookie('rnx_session');audit(req.user,'LOGOUT','USER',req.user.id);res.json({ok:true})});

// Discord OAuth: required for normal registration when configured.
app.get('/api/auth/discord/start',(req,res)=>{
 const client=process.env.DISCORD_CLIENT_ID, redirect=process.env.DISCORD_REDIRECT_URI;
 if(!client||!redirect)return res.status(503).json({error:'DISCORD_NOT_CONFIGURED'});
 const params=new URLSearchParams({client_id:client,response_type:'code',redirect_uri:redirect,scope:'identify'});
 res.redirect('https://discord.com/oauth2/authorize?'+params.toString());
});
app.get('/api/auth/discord/callback',async(req,res)=>{
 try{
  const {code}=req.query;if(!code)throw Error('missing code');
  const body=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:process.env.DISCORD_REDIRECT_URI});
  const tokenR=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  if(!tokenR.ok)throw Error('discord token exchange failed');
  const token=await tokenR.json();
  const meR=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});if(!meR.ok)throw Error('discord profile failed');
  const d=await meR.json();
  const temp=nanoid(32);db.prepare('CREATE TABLE IF NOT EXISTS discord_pending(token TEXT PRIMARY KEY,discord_id TEXT NOT NULL,discord_name TEXT NOT NULL,expires_at TEXT NOT NULL)').run();db.prepare('INSERT INTO discord_pending VALUES(?,?,?,?)').run(temp,d.id,d.username,new Date(Date.now()+10*60000).toISOString());
  res.redirect('/?discord_verified='+encodeURIComponent(temp));
 }catch(e){res.status(400).send('Discord verification failed. Check server configuration.');}
});
app.post('/api/auth/register',(req,res)=>{
 const {pendingToken,icName,password}=req.body||{}; if(!pendingToken) return res.status(400).json({error:'DISCORD_VERIFICATION_REQUIRED'});
 db.prepare('CREATE TABLE IF NOT EXISTS discord_pending(token TEXT PRIMARY KEY,discord_id TEXT NOT NULL,discord_name TEXT NOT NULL,expires_at TEXT NOT NULL)').run();
 const d=db.prepare('SELECT * FROM discord_pending WHERE token=? AND expires_at>?').get(pendingToken,now());if(!d)return res.status(400).json({error:'DISCORD_TOKEN_EXPIRED'});
 const name=String(icName||'').trim();if(!/^[\w\- ]{2,32}$/u.test(name))return res.status(400).json({error:'INVALID_IC_NAME'});if(String(password||'').length<8)return res.status(400).json({error:'PASSWORD_TOO_SHORT'});
 try{const hash=bcrypt.hashSync(String(password),12);const r=db.prepare('INSERT INTO users(ic_name,password_hash,discord_id,discord_name) VALUES(?,?,?,?)').run(name,hash,d.discord_id,d.discord_name);db.prepare('DELETE FROM discord_pending WHERE token=?').run(pendingToken);const u=userById(r.lastInsertRowid);loginSession(res,u);audit(u,'REGISTER','USER',u.id,{discord_id:d.discord_id});res.json({user:{...publicUser(u),role:u.role}})}catch(e){if(String(e.message).includes('discord_id'))return res.status(409).json({error:'DISCORD_ALREADY_LINKED'});return res.status(409).json({error:'IC_NAME_ALREADY_USED'});}
});

app.get('/api/public/leaderboards',(req,res)=>{
 const season=currentSeason();
 const all=db.prepare(`SELECT u.id,u.ic_name,u.total_points,COALESCE((SELECT SUM(pc.amount) FROM point_changes pc WHERE pc.user_id=u.id AND datetime(pc.created_at)>=datetime('now','-24 hours')),0) delta24h FROM users u WHERE u.status='ACTIVE' ORDER BY u.total_points DESC,u.ic_name ASC LIMIT 100`).all().map((u,i)=>({rank:i+1,icName:u.ic_name,points:u.total_points,delta24h:u.delta24h}));
 let current=[]; if(season) current=db.prepare(`SELECT u.ic_name,COALESCE(SUM(pc.amount),0) points FROM users u LEFT JOIN point_changes pc ON pc.user_id=u.id WHERE u.status='ACTIVE' AND (pc.created_at>=? OR pc.created_at IS NULL) GROUP BY u.id ORDER BY points DESC,u.ic_name ASC LIMIT 100`).all(season.start_at||'0000-01-01').map((u,i)=>({rank:i+1,icName:u.ic_name,points:u.points}));
 res.json({season,all,current});
});
app.get('/api/public/races',(req,res)=>res.json({races:db.prepare(`SELECT r.*,s.name season_name FROM races r LEFT JOIN seasons s ON s.id=r.season_id ORDER BY datetime(r.scheduled_at) DESC`).all()}));
app.get('/api/public/history',(req,res)=>res.json({history:db.prepare(`SELECT r.id,r.name,r.scheduled_at,r.ended_at,s.name season_name,COUNT(DISTINCT p.user_id) participants FROM races r LEFT JOIN seasons s ON s.id=r.season_id LEFT JOIN participants p ON p.race_id=r.id WHERE r.status='COMPLETED' GROUP BY r.id ORDER BY datetime(r.ended_at) DESC`).all()}));
app.get('/api/public/seasons',(req,res)=>res.json({seasons:db.prepare(`SELECT s.*,u.ic_name winner_name FROM seasons s LEFT JOIN users u ON u.id=s.winner_user_id ORDER BY id DESC`).all()}));
app.get('/api/public/sanctions',(req,res)=>res.json({sanctions:db.prepare(`SELECT s.id,u.ic_name,s.type,s.amount,s.reason,s.status,s.starts_at,s.ends_at FROM sanctions s JOIN users u ON u.id=s.user_id ORDER BY datetime(s.created_at) DESC`).all()}));
app.get('/api/public/players',(req,res)=>{const q=String(req.query.q||'').trim();const rows=q?db.prepare('SELECT id,ic_name,total_points,status FROM users WHERE status="ACTIVE" AND ic_name LIKE ? ORDER BY ic_name LIMIT 50').all('%'+q+'%'):[];res.json({players:rows.map(publicUser)});});
app.get('/api/public/profile/:id',(req,res)=>{const u=userById(req.params.id);if(!u||u.status!=='ACTIVE')return res.status(404).json({error:'NOT_FOUND'});const season=currentSeason();const history=db.prepare(`SELECT r.id,r.name,r.scheduled_at,g.placement,g.points_awarded,g.finished_at FROM goals g JOIN races r ON r.id=g.race_id WHERE g.user_id=? ORDER BY datetime(g.finished_at) DESC`).all(u.id);res.json({profile:{...publicUser(u),delta24h:db.prepare(`SELECT COALESCE(SUM(amount),0) d FROM point_changes WHERE user_id=? AND datetime(created_at)>=datetime('now','-24 hours')`).get(u.id).d},seasonPoints:season?db.prepare(`SELECT COALESCE(SUM(amount),0) p FROM point_changes WHERE user_id=? AND created_at>=?`).get(u.id,season.start_at||'0000-01-01').p:0,history,sanctions:db.prepare('SELECT type,amount,reason,status,starts_at,ends_at FROM sanctions WHERE user_id=? ORDER BY datetime(created_at) DESC').all(u.id)});});

app.use('/api',auth);
app.get('/api/races/:id',(req,res)=>{const r=db.prepare('SELECT r.*,s.name season_name FROM races r LEFT JOIN seasons s ON s.id=r.season_id WHERE r.id=?').get(req.params.id);if(!r)return res.status(404).json({error:'NOT_FOUND'});const cps=db.prepare('SELECT c.*,u.ic_name operator_name FROM checkpoints c LEFT JOIN users u ON u.id=c.operator_user_id WHERE c.race_id=? ORDER BY c.seq').all(r.id);const parts=db.prepare('SELECT u.id,u.ic_name,p.joined_at,g.finished_at,g.placement,g.points_awarded FROM participants p JOIN users u ON u.id=p.user_id LEFT JOIN goals g ON g.race_id=p.race_id AND g.user_id=p.user_id WHERE p.race_id=? ORDER BY u.ic_name').all(r.id);res.json({race:r,checkpoints:cps,participants:parts});});
app.post('/api/races/:id/join',(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);if(!r||r.status!=='PLANNED')return res.status(400).json({error:'RACE_NOT_OPEN'});db.prepare('INSERT OR IGNORE INTO participants(race_id,user_id) VALUES(?,?)').run(r.id,req.user.id);audit(req.user,'RACE_JOIN','RACE',r.id);res.json({ok:true})});
app.delete('/api/races/:id/join',(req,res)=>{db.prepare('DELETE FROM participants WHERE race_id=? AND user_id=?').run(req.params.id,req.user.id);res.json({ok:true})});

app.post('/api/races',owner,(req,res)=>{const {name,scheduledAt,startPoint,seasonId,checkpoints=[]}=req.body||{};if(!name||!scheduledAt||!startPoint)return res.status(400).json({error:'MISSING_FIELDS'});if(!Array.isArray(checkpoints)||checkpoints.length>5)return res.status(400).json({error:'MAX_5_CHECKPOINTS'});const tx=db.transaction(()=>{const r=db.prepare('INSERT INTO races(name,scheduled_at,start_point,season_id,created_by) VALUES(?,?,?,?,?)').run(name,new Date(scheduledAt).toISOString(),startPoint,seasonId||null,req.user.id);const ins=db.prepare('INSERT INTO checkpoints(race_id,seq,name,operator_user_id) VALUES(?,?,?,?)');checkpoints.forEach((c,i)=>ins.run(r.lastInsertRowid,i+1,String(c.name||`CP${i+1}`),c.operatorUserId||null));audit(req.user,'RACE_CREATE','RACE',r.lastInsertRowid,{name,checkpoints:checkpoints.length});return r.lastInsertRowid});res.json({id:tx()})});
app.post('/api/races/:id/start',owner,(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);if(!r||r.status!=='PLANNED')return res.status(400).json({error:'INVALID_RACE_STATE'});const t=now();db.prepare("UPDATE races SET status='ACTIVE',started_at=? WHERE id=?").run(t,r.id);audit(req.user,'RACE_START','RACE',r.id,{serverTime:t});broadcast(r.id,{type:'RACE_STARTED',serverTime:t});res.json({ok:true,startedAt:t})});
app.post('/api/races/:id/end',owner,(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);if(!r||r.status!=='ACTIVE')return res.status(400).json({error:'INVALID_RACE_STATE'});rankGoals(r.id);const t=now();db.prepare("UPDATE races SET status='COMPLETED',ended_at=? WHERE id=?").run(t,r.id);audit(req.user,'RACE_END','RACE',r.id,{serverTime:t});broadcast(r.id,{type:'RACE_ENDED',serverTime:t});res.json({ok:true,endedAt:t})});
app.post('/api/races/:id/checkpoints',owner,(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);if(!r||r.status!=='PLANNED')return res.status(400).json({error:'RACE_NOT_EDITABLE'});const cps=req.body?.checkpoints||[];if(cps.length>5)return res.status(400).json({error:'MAX_5_CHECKPOINTS'});const tx=db.transaction(()=>{db.prepare('DELETE FROM checkpoints WHERE race_id=?').run(r.id);const ins=db.prepare('INSERT INTO checkpoints(race_id,seq,name,operator_user_id) VALUES(?,?,?,?)');cps.forEach((c,i)=>ins.run(r.id,i+1,String(c.name||`CP${i+1}`),c.operatorUserId||null));audit(req.user,'CHECKPOINTS_UPDATE','RACE',r.id,{count:cps.length})});tx();res.json({ok:true})});
app.post('/api/races/:raceId/checkpoints/:checkpointId/confirm',(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId),c=db.prepare('SELECT * FROM checkpoints WHERE id=? AND race_id=?').get(req.params.checkpointId,req.params.raceId);if(!r||!c||r.status!=='ACTIVE')return res.status(400).json({error:'RACE_NOT_ACTIVE'});const target=String(req.body?.icName||'').trim();const u=db.prepare('SELECT * FROM users WHERE ic_name=? AND status="ACTIVE"').get(target);if(!u)return res.status(404).json({error:'DRIVER_NOT_FOUND'});const isOp=c.operator_user_id===req.user.id;if(!isOp && u.id!==req.user.id && req.user.role!=='OWNER')return res.status(403).json({error:'NOT_OPERATOR'});if(!db.prepare('SELECT 1 FROM participants WHERE race_id=? AND user_id=?').get(r.id,u.id))return res.status(400).json({error:'NOT_PARTICIPANT'});if(db.prepare('SELECT 1 FROM checkpoint_passes WHERE race_id=? AND checkpoint_id=? AND user_id=?').get(r.id,c.id,u.id))return res.status(409).json({error:'ALREADY_CONFIRMED'});const t=now(),type=isOp||req.user.role==='OWNER'?'OPERATOR':'SELF';const st=type==='SELF'?'PENDING':'APPROVED';const id=db.prepare('INSERT INTO checkpoint_passes(race_id,checkpoint_id,user_id,confirmed_at,confirmed_by,confirmation_type,status) VALUES(?,?,?,?,?,?,?)').run(r.id,c.id,u.id,t,req.user.id,type,st).lastInsertRowid;if(type==='OPERATOR'||req.user.role==='OWNER')recomputeCheckpointPoints(r.id,c.id);audit(req.user,'CHECKPOINT_CONFIRM','CHECKPOINT',c.id,{raceId:r.id,userId:u.id,type,serverTime:t});broadcast(r.id,{type:'CHECKPOINT',checkpointId:c.id,userId:u.id,icName:u.ic_name,serverTime:t,confirmationType:type});res.json({ok:true,serverTime:t,confirmationType:type,id})});
app.post('/api/races/:raceId/goals',(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.raceId);if(!r||r.status!=='ACTIVE')return res.status(400).json({error:'RACE_NOT_ACTIVE'});const target=String(req.body?.icName||'').trim(),u=db.prepare('SELECT * FROM users WHERE ic_name=? AND status="ACTIVE"').get(target);if(!u)return res.status(404).json({error:'DRIVER_NOT_FOUND'});if(!db.prepare('SELECT 1 FROM participants WHERE race_id=? AND user_id=?').get(r.id,u.id))return res.status(400).json({error:'NOT_PARTICIPANT'});if(db.prepare('SELECT 1 FROM goals WHERE race_id=? AND user_id=?').get(r.id,u.id))return res.status(409).json({error:'ALREADY_FINISHED'});const type=req.user.role==='OWNER'?'OPERATOR':req.user.id===u.id?'SELF':null;if(!type)return res.status(403).json({error:'NOT_ALLOWED'});const t=now();const id=db.prepare('INSERT INTO goals(race_id,user_id,finished_at,confirmed_by,confirmation_type) VALUES(?,?,?,?,?)').run(r.id,u.id,t,req.user.id,type).lastInsertRowid;rankGoals(r.id);audit(req.user,'GOAL_CONFIRM','RACE',r.id,{userId:u.id,type,serverTime:t});broadcast(r.id,{type:'GOAL',userId:u.id,icName:u.ic_name,serverTime:t});res.json({ok:true,serverTime:t,id})});

app.post('/api/owner/checkpoint-passes/:id/review',owner,(req,res)=>{const pass=db.prepare('SELECT * FROM checkpoint_passes WHERE id=?').get(req.params.id);const status=req.body?.status;if(!pass||!['APPROVED','REJECTED','CORRECTED'].includes(status))return res.status(400).json({error:'INVALID_REVIEW'});db.prepare('UPDATE checkpoint_passes SET status=? WHERE id=?').run(status,pass.id);if(status==='APPROVED'||status==='CORRECTED')recomputeCheckpointPoints(pass.race_id,pass.checkpoint_id);audit(req.user,'CHECKPOINT_REVIEW','CHECKPOINT_PASS',pass.id,{status});broadcast(pass.race_id,{type:'CHECKPOINT_REVIEW',passId:pass.id,status});res.json({ok:true})});
app.get('/api/owner/users',owner,(req,res)=>res.json({users:db.prepare('SELECT id,ic_name,discord_name,discord_id,role,status,total_points,created_at FROM users ORDER BY id').all()}));
app.post('/api/owner/users/:id/status',owner,(req,res)=>{const u=userById(req.params.id);if(!u)return res.status(404).json({error:'NOT_FOUND'});const status=req.body?.status;if(!['ACTIVE','BLOCKED'].includes(status))return res.status(400).json({error:'INVALID_STATUS'});db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run(status,now(),u.id);audit(req.user,'USER_STATUS','USER',u.id,{status});res.json({ok:true})});
app.post('/api/owner/users/:id/role',owner,(req,res)=>{const u=userById(req.params.id),role=req.body?.role;if(!u||!['DRIVER','OWNER'].includes(role))return res.status(400).json({error:'INVALID_ROLE'});if(role==='OWNER'&&u.role!=='OWNER'&&ownerCount()>=4)return res.status(409).json({error:'MAX_4_OWNERS'});if(role==='DRIVER'&&u.id===req.user.id&&ownerCount()<=1)return res.status(400).json({error:'LAST_OWNER'});db.prepare('UPDATE users SET role=?,updated_at=? WHERE id=?').run(role,now(),u.id);audit(req.user,'ROLE_CHANGE','USER',u.id,{role});res.json({ok:true})});
app.post('/api/owner/points',owner,(req,res)=>{const {userId,amount,reason}=req.body||{};const u=userById(userId),n=Number(amount);if(!u||!Number.isFinite(n)||!reason)return res.status(400).json({error:'INVALID_POINT_CHANGE'});if(u.total_points+n<-100)return res.status(400).json({error:'MINUS_100_LIMIT'});addPoints(u.id,n,String(reason),req.user.id,'MANUAL');audit(req.user,'MANUAL_POINTS','USER',u.id,{amount:n,reason});res.json({ok:true,newTotal:userById(u.id).total_points})});
app.post('/api/owner/sanctions',owner,(req,res)=>{const {userId,type,amount,reason,endsAt,seasonId}=req.body||{};const u=userById(userId),a=Number(amount);if(!u||!['POINTS','MONEY'].includes(type)||!Number.isFinite(a)||a<=0||!reason)return res.status(400).json({error:'INVALID_SANCTION'});const delta=type==='POINTS'?-Math.abs(a):0;if(type==='POINTS'&&u.total_points+delta<-100)return res.status(400).json({error:'MINUS_100_LIMIT'});const tx=db.transaction(()=>{const id=db.prepare('INSERT INTO sanctions(user_id,type,amount,reason,ends_at,season_id,created_by) VALUES(?,?,?,?,?,?,?)').run(userId,type,a,reason,endsAt||null,seasonId||null,req.user.id).lastInsertRowid;if(delta)addPoints(userId,delta,`Sanktion: ${reason}`,req.user.id,'SANCTION');audit(req.user,'SANCTION_CREATE','SANCTION',id,{userId,type,amount:a,reason});return id});res.json({ok:true,id:tx()})});

app.get('/api/owner/seasons',owner,(req,res)=>res.json({seasons:db.prepare('SELECT s.*,u.ic_name winner_name FROM seasons s LEFT JOIN users u ON u.id=s.winner_user_id ORDER BY id DESC').all()}));
app.post('/api/owner/seasons',owner,(req,res)=>{const {name,startAt,endAt,reward}=req.body||{};if(!name)return res.status(400).json({error:'NAME_REQUIRED'});const id=db.prepare('INSERT INTO seasons(name,start_at,end_at,reward) VALUES(?,?,?,?)').run(name,startAt||null,endAt||null,reward||null).lastInsertRowid;audit(req.user,'SEASON_CREATE','SEASON',id,{name});res.json({ok:true,id})});
app.post('/api/owner/seasons/:id/start',owner,(req,res)=>{const s=db.prepare('SELECT * FROM seasons WHERE id=?').get(req.params.id);if(!s)return res.status(404).json({error:'NOT_FOUND'});if(currentSeason())return res.status(409).json({error:'ACTIVE_SEASON_EXISTS'});db.prepare("UPDATE seasons SET status='ACTIVE',start_at=COALESCE(start_at,?) WHERE id=?").run(now(),s.id);audit(req.user,'SEASON_START','SEASON',s.id);res.json({ok:true})});
app.post('/api/owner/seasons/:id/end',owner,(req,res)=>{const s=db.prepare('SELECT * FROM seasons WHERE id=?').get(req.params.id);if(!s||s.status!=='ACTIVE')return res.status(400).json({error:'NOT_ACTIVE'});const winner=db.prepare(`SELECT u.id,COALESCE(SUM(pc.amount),0) points FROM users u LEFT JOIN point_changes pc ON pc.user_id=u.id AND pc.created_at>=? GROUP BY u.id ORDER BY points DESC LIMIT 1`).get(s.start_at||'0000-01-01');db.prepare("UPDATE seasons SET status='COMPLETED',end_at=COALESCE(end_at,?),winner_user_id=? WHERE id=?").run(now(),winner?.id||null,s.id);audit(req.user,'SEASON_END','SEASON',s.id,{winnerUserId:winner?.id||null});res.json({ok:true,winner:winner||null})});
app.get('/api/owner/audit',owner,(req,res)=>res.json({logs:db.prepare(`SELECT a.*,u.ic_name actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT 500`).all()}));

const streams=new Map();
function broadcast(raceId,event){const set=streams.get(String(raceId));if(!set)return;const data=`data: ${JSON.stringify(event)}\n\n`;for(const res of set){res.write(data);}}
app.get('/api/races/:id/live',(req,res)=>{const r=db.prepare('SELECT * FROM races WHERE id=?').get(req.params.id);if(!r)return res.status(404).end();res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders?.();const key=String(r.id);if(!streams.has(key))streams.set(key,new Set());streams.get(key).add(res);res.write(`data: ${JSON.stringify({type:'CONNECTED',serverTime:now()})}\n\n`);req.on('close',()=>streams.get(key)?.delete(res));});

app.use((req,res)=>{ if(req.method==='GET' && !req.path.startsWith('/api/')) return res.sendFile('index.html',{root:'public'}); res.status(404).json({error:'NOT_FOUND'}); });

app.listen(PORT,()=>console.log(`RONIN NOX running on http://localhost:${PORT}`));

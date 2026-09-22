const drivers=[
 {ic:'KAZE',points:127.5,all:127.5,races:14,wins:5,delta:7.5},
 {ic:'AKUMA',points:112.5,all:112.5,races:13,wins:4,delta:-2.5},
 {ic:'SHADOW',points:96,races:12,wins:2,delta:5},
 {ic:'RAIJIN',points:84.5,races:11,wins:2,delta:0},
 {ic:'KITSUNE',points:73,races:10,wins:1,delta:-5},
 {ic:'ZERO',points:61,races:9,wins:1,delta:2.5},
 {ic:'KAGE',points:48.5,races:8,wins:0,delta:4},
 {ic:'JIN',points:41,races:7,wins:0,delta:-1}
];
const history=[
 ['024','NIGHT CIRCUIT // 04','12.09.2026','KAZE','18:42.381'],['023','REDLINE RUN // 03','05.09.2026','AKUMA','16:11.904'],['022','DOCKSIDE SPRINT // 02','28.08.2026','SHADOW','09:57.220'],['021','BLACK RAIN // 01','21.08.2026','KAZE','21:04.511'],['020','NEON LOOP // 08','14.08.2026','RAIJIN','14:38.920']
];
let board='season',logged=null;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(window.__t);window.__t=setTimeout(()=>e.classList.remove('show'),2400)}
function open(id){$(id).classList.add('open')} function closeAll(){$$('.modal').forEach(m=>m.classList.remove('open'))}
function renderBoard(){let list=[...drivers].sort((a,b)=>b.points-a.points);if(board==='all')list=list.map(d=>({...d,points:d.all})).sort((a,b)=>b.points-a.points);const top=list.slice(0,3);$('#podium').innerHTML=top.map((d,i)=>`<div class="pod ${i===0?'first':i===1?'second':'third'}"><div class="medal">${['01','02','03'][i]}</div><b>${d.ic}</b><small>${d.points.toFixed(1).replace('.0','')} POINTS</small><div class="bar"></div></div>`).join('');$('#rankRows').innerHTML=list.map((d,i)=>`<div class="rank-row"><span class="pos">#${String(i+1).padStart(2,'0')}</span><span class="driver-name">${d.ic}<small>${i<3?'TOP DRIVER':'STREET DIVISION'}</small></span><span class="races">${d.races}</span><span class="points">${d.points.toFixed(1).replace('.0','')} <i class="delta">${d.delta>0?'+':''}${d.delta.toFixed(1).replace('.0','')}</i></span></div>`).join('')}
function renderHistory(){$('#historyList').innerHTML=history.map(r=>`<div class="history-row"><div>${r[0]}</div><div class="race-name">${r[1]}</div><div><span class="label">DATE</span>${r[2]}</div><div><span class="label">WINNER</span><span class="winner">${r[3]}</span></div><div>${r[4]}</div></div>`).join('')}
function login(){const ic=$('#loginIc').value.trim().toUpperCase(),pw=$('#loginPw').value;if((ic==='KAZE'||ic==='AKUMA')&&pw==='ronin123'){logged=drivers.find(d=>d.ic===ic);closeAll();$('#authBtn').textContent=ic;toast(`WILLKOMMEN ${ic}`);setTimeout(()=>openProfile(),250)}else toast('DEMO: KAZE oder AKUMA / ronin123')}
function openProfile(){if(!logged)return open('#authModal');$('#profileName').textContent=logged.ic;$('#profilePoints').textContent=logged.points;open('#profileModal')}
function join(){if(!logged){open('#authModal');return}toast(`${logged.ic} — TEILNAHME BESTÄTIGT`);$('#joinBtn').textContent='TEILNAHME BESTÄTIGT';$('#joinBtn').disabled=true;$('#joinBtn').style.opacity='.55'}
function startCountdown(){const target=new Date('2026-09-26T22:00:00');const tick=()=>{let d=Math.max(0,target-new Date()),days=Math.floor(d/864e5);d%=864e5;let h=Math.floor(d/36e5);d%=36e5;let m=Math.floor(d/6e4);let s=Math.floor(d/1e3)%60;$('#countdown').textContent=`${String(days).padStart(2,'0')} : ${String(h).padStart(2,'0')} : ${String(m).padStart(2,'0')} : ${String(s).padStart(2,'0')}`};tick();setInterval(tick,1000)}
$$('.tabs button').forEach(b=>b.onclick=()=>{$$('.tabs button').forEach(x=>x.classList.remove('active'));b.classList.add('active');board=b.dataset.board;renderBoard()});
$('#authBtn').onclick=()=>logged?openProfile():open('#authModal');$('#heroLogin').onclick=()=>open('#authModal');$('#ctaLogin').onclick=()=>open('#authModal');$('#joinBtn').onclick=join;$('#detailsBtn').onclick=()=>open('#raceModal');$('#modalJoin').onclick=()=>{closeAll();join()};$('#loginForm').onsubmit=e=>{e.preventDefault();login()};$('#logoutBtn').onclick=()=>{logged=null;closeAll();$('#authBtn').textContent='LOGIN';toast('ABGEMELDET')};
$$('.close,.backdrop').forEach(x=>x.onclick=closeAll);$('#menuBtn').onclick=()=>toast('Navigation: HOME · NEXT RACE · LEADERBOARD · HISTORY · RULES');
renderBoard();renderHistory();startCountdown();

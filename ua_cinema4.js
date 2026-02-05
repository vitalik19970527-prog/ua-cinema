(function () {
'use strict';

if (window.Lampa) {
    Lampa.Manifest = {
        type: 'other',
        version: '1.0.0',
        name: 'UA Cinema',
        description: 'UA Online + UA Torrent Online',
        component: 'ua_online'
    };
}
Lampa.Plugin = true;

/* ======================================================
 * GLOBAL HELPERS / STORAGE
 * ====================================================== */

function cid(card){return card.imdb_id||card.kinopoisk_id||card.id;}
function kVoice(c){return 'ua_voice_'+cid(c);}
function kProg(c){return 'ua_prog_'+cid(c);}
function kTime(c,s,e){return `ua_time_${cid(c)}_${s}_${e}`;}
function kTorrentFile(c){return 'ua_torrent_file_'+cid(c);}
function kTorrentCache(c){return 'ua_torrent_cache_'+cid(c);}

function saveVoice(c,v){Lampa.Storage.set(kVoice(c),v);}
function loadVoice(c){return Lampa.Storage.get(kVoice(c),null);}
function saveProg(c,s,e){Lampa.Storage.set(kProg(c),{season:s,episode:e});}
function loadProg(c){return Lampa.Storage.get(kProg(c),null);}

let __ts=0;
function saveTime(c,s,e,t){
 if(Date.now()-__ts<5000)return;
 __ts=Date.now();
 Lampa.Storage.set(kTime(c,s,e),{time:t});
}
function loadTime(c,s,e){return Lampa.Storage.get(kTime(c,s,e),null);}

function saveTorrentFile(c,i){Lampa.Storage.set(kTorrentFile(c),i);}
function loadTorrentFile(c){return Lampa.Storage.get(kTorrentFile(c),null);}

function saveTorrentCache(c,data){
 Lampa.Storage.set(kTorrentCache(c),{time:Date.now(),data});
}
function loadTorrentCache(c,ttl){
 const d=Lampa.Storage.get(kTorrentCache(c),null);
 if(!d)return null;
 if(ttl && Date.now()-d.time>ttl)return null;
 return d.data;
}
function clearTorrentCache(c){Lampa.Storage.remove(kTorrentCache(c));}
function clearAllTorrentCache(){
 Object.keys(Lampa.Storage.data||{})
  .filter(k=>k.startsWith('ua_torrent_cache_'))
  .forEach(k=>Lampa.Storage.remove(k));
}

/* ======================================================
 * SETTINGS
 * ====================================================== */

const SETTINGS_KEY='ua_cinema_settings';
const DEFAULT_SETTINGS={
 quality:'auto',
 autoplay:true,
 ua_priority:true,
 ru_fallback:true,
 torrserver:'http://127.0.0.1:8090',
 torrent_cache:true,
 cache_ttl:24
};

function loadSettings(){
 return Object.assign({},DEFAULT_SETTINGS,
  Lampa.Storage.get(SETTINGS_KEY,{}));
}
function saveSettings(s){Lampa.Storage.set(SETTINGS_KEY,s);}

/* ======================================================
 * UA FILTERS
 * ====================================================== */

const UA_KEYS=[
 'ua','ukr','ukrain','україн',
 'eneida','ashdi','uakino',
 'ledoyen','hurtom','toloka'
];
const RU_FALLBACK=['lostfilm','newstudio'];

function norm(v){return String(v||'').toLowerCase();}
function isUA(t){
 t=norm(t);
 if(t.includes('sub'))return false;
 return UA_KEYS.some(k=>t.includes(k));
}
function isRU(t){
 return RU_FALLBACK.some(k=>norm(t).includes(k));
}
function detectQuality(t){
 t=t.toLowerCase();
 if(t.includes('2160')||t.includes('4k'))return '2160p';
 if(t.includes('1080'))return '1080p';
 if(t.includes('720'))return '720p';
 if(t.includes('480'))return '480p';
 return 'unknown';
}

/* ======================================================
 * FILMIX PROVIDER (ONLINE)
 * ====================================================== */

const FILMIX_ENDPOINTS=[
 'https://filmix.biz/api/player',
 'https://filmix.pro/api/player',
 'https://filmix.site/api/player'
];

function Filmix(){
 this.net=new Lampa.Reguest();
 this.cache={};
}

Filmix.prototype.search=function(card,cb){
 const id=cid(card);
 if(!id)return cb(null);
 if(this.cache[id])return cb(this.cache[id]);

 const eps=FILMIX_ENDPOINTS.slice();
 const tryNext=()=>{
  if(!eps.length)return cb(null);
  this.net.silent(eps.shift(),
   j=>{
    if(j&&j.player&&j.player.translations){
     const data=this.parse(j,card);
     if(data){this.cache[id]=data;cb(data);}
     else tryNext();
    } else tryNext();
   },
   tryNext,
   {method:'POST',timeout:5000,data:{query:id}}
  );
 };
 tryNext();
};

Filmix.prototype.parse=function(j,card){
 const ua=[],ru=[];
 j.player.translations.forEach(t=>{
  if(isUA(t.title))ua.push(t);
  else if(isRU(t.title))ru.push(t);
 });
 const use=ua.length?ua:ru.slice(0,2);
 if(!use.length)return null;

 const matrix={},cover={};
 use.forEach(t=>{
  cover[t.title]=0;
  t.playlist.forEach(s=>{
   s.episodes.forEach(e=>{
    matrix[s.season]??={};
    matrix[s.season][e.episode]??=[];
    matrix[s.season][e.episode].push({
     tr:t.title, url:e.file
    });
    cover[t.title]++;
   });
  });
 });
 const priority=Object.entries(cover)
  .sort((a,b)=>b[1]-a[1])[0][0];
 return {card,title:card.title,matrix,priority};
};

/* ======================================================
 * UA ONLINE COMPONENT
 * ====================================================== */

function UAOnline(o){
 this.card=o.card;
 this.start=o.start_from||null;
 this.html=$('<div></div>');
 this.provider=new Filmix();
}

UAOnline.prototype.create=function(){
 Lampa.Loading.show();
 this.provider.search(this.card,d=>{
  Lampa.Loading.hide();
  if(!d)return this.empty();
  this.item=d;
  this.renderSeasons();
  if(this.start)
   this.playEpisode(d,this.start.season,this.start.episode);
 });
 return this.html;
};

UAOnline.prototype.renderSeasons=function(){
 const w=$('<div class="online-list"></div>');
 Object.keys(this.item.matrix).forEach(s=>{
  const el=$(`<div class="online-list__item selector">
   <div class="online-list__title">Сезон ${s}</div>
  </div>`);
  el.on('hover:enter',()=>this.renderEpisodes(s));
  w.append(el);
 });
 this.html.html(w);
 Lampa.Controller.collectionSet(w);
 Lampa.Controller.make(w);
};

UAOnline.prototype.renderEpisodes=function(season){
 const w=$('<div class="online-list"></div>');
 const p=loadProg(this.card);
 Object.keys(this.item.matrix[season]).forEach(e=>{
  const vars=this.item.matrix[season][e];
  const sv=loadVoice(this.card);
  const pref=vars.find(v=>v.tr===sv)||
   vars.find(v=>v.tr===this.item.priority)||vars[0];
  const watched=p&&season==p.season&&e<=p.episode;
  const el=$(`<div class="online-list__item selector${watched?' watched':''}">
   <div class="online-list__title">Серія ${e}</div>
   <div class="online-list__quality">${pref.tr}</div>
  </div>`);
  el.on('hover:enter',()=>this.playEpisode(this.item,season,e));
  w.append(el);
 });
 this.html.html(w);
 Lampa.Controller.collectionSet(w);
 Lampa.Controller.make(w);
};

UAOnline.prototype.playEpisode=function(item,s,e){
 const vars=item.matrix[s][e];
 const sv=loadVoice(this.card);
 const v=vars.find(x=>x.tr===sv)||vars[0];
 saveVoice(this.card,v.tr);
 const r=loadTime(this.card,s,e);

 Lampa.Player.play({
  url:v.url,
  title:`${item.title} — С${s}Е${e}`,
  time:r&&r.time>30?r.time:0,
  ontime:t=>saveTime(this.card,s,e,t),
  onpause:t=>saveTime(this.card,s,e,t),
  onended:()=>{
   saveProg(this.card,s,e);
   this.next(item,s,e);
  }
 });
};

UAOnline.prototype.next=function(item,s,e){
 const eps=Object.keys(item.matrix[s]).map(Number);
 const i=eps.indexOf(+e);
 if(i<eps.length-1)
  return this.playEpisode(item,s,eps[i+1]);
 const ss=Object.keys(item.matrix).map(Number);
 const si=ss.indexOf(+s);
 if(si<ss.length-1){
  const ns=ss[si+1];
  const ne=Object.keys(item.matrix[ns])[0];
  this.playEpisode(item,ns,ne);
 }
};

UAOnline.prototype.empty=function(){
 this.html.html('<div class="empty"><h3>Немає української озвучки</h3></div>');
};

Lampa.Component.add('ua_online',UAOnline);

/* ======================================================
 * TORRENT SEARCH ENGINE
 * ====================================================== */

function TorrentSearch(){
 this.net=new Lampa.Reguest();
}

TorrentSearch.prototype.search=function(card,quality,cb){
 const q=encodeURIComponent(`${card.title} ${card.year||''} ukr`);
 this.net.silent(
  `https://apibay.org/q.php?q=${q}&cat=0`,
  j=>{
   if(!Array.isArray(j))return cb([]);
   const r=j.map(t=>({
    title:t.name,
    magnet:`magnet:?xt=urn:btih:${t.info_hash}`,
    seeders:+t.seeders||0,
    quality:detectQuality(t.name),
    ua:isUA(t.name)
   }))
   .filter(t=>t.ua)
   .filter(t=>quality==='auto'||t.quality===quality)
   .sort((a,b)=>b.seeders-a.seeders);
   cb(r);
  },
  ()=>cb([])
 );
};

/* ======================================================
 * UA TORRENT COMPONENT
 * ====================================================== */

function UATorrent(o){
 this.card=o.card;
 this.html=$('<div></div>');
 this.settings=loadSettings();
}

UATorrent.prototype.create=function(){
 this.checkServer(ok=>{
  if(!ok)return this.help();
  this.pickQuality();
 });
 return this.html;
};

UATorrent.prototype.checkServer=function(cb){
 const net=new Lampa.Reguest();
 net.silent(
  this.settings.torrserver+'/echo',
  ()=>cb(true),
  ()=>cb(false),
  {timeout:2000}
 );
};

UATorrent.prototype.help=function(){
 Lampa.Modal.open({
  title:'UA Torrent Online',
  html:`Для перегляду торрентів потрібен TorrServer<br>
  <a href="https://github.com/YouROK/TorrServer">Завантажити</a>`
 });
};

UATorrent.prototype.pickQuality=function(){
 const w=$('<div class="online-list"></div>');
 ['auto','720p','1080p','2160p'].forEach(q=>{
  const el=$(`<div class="online-list__item selector">
   <div class="online-list__title">Якість ${q}</div>
  </div>`);
  el.on('hover:enter',()=>this.search(q));
  w.append(el);
 });
 this.html.html(w);
 Lampa.Controller.collectionSet(w);
 Lampa.Controller.make(w);
};

UATorrent.prototype.search=function(q){
 const eng=new TorrentSearch();
 Lampa.Activity.loader(true);
 eng.search(this.card,q,res=>{
  Lampa.Activity.loader(false);
  if(!res.length)return this.empty();
  const w=$('<div class="online-list"></div>');
  res.forEach(t=>{
   const el=$(`<div class="online-list__item selector">
    <div class="online-list__title">${t.title}</div>
    <div class="online-list__quality">
     🇺🇦 🎞️ ${t.quality} 🌱 ${t.seeders}
    </div>
   </div>`);
   el.on('hover:enter',()=>this.openTorrent(t));
   w.append(el);
  });
  this.html.html(w);
  Lampa.Controller.collectionSet(w);
  Lampa.Controller.make(w);
 });
};

UATorrent.prototype.openTorrent=function(t){
 const cached=this.settings.torrent_cache?
  loadTorrentCache(this.card,this.settings.cache_ttl*3600000):null;
 if(cached)return this.handleFiles(cached,t);
 const net=new Lampa.Reguest();
 Lampa.Activity.loader(true);
 net.silent(
  this.settings.torrserver+'/stream/files?link='+encodeURIComponent(t.magnet),
  f=>{
   Lampa.Activity.loader(false);
   if(this.settings.torrent_cache)saveTorrentCache(this.card,f);
   this.handleFiles(f,t);
  },
  ()=>{Lampa.Activity.loader(false);this.empty();}
 );
};

UATorrent.prototype.handleFiles=function(files,t){
 const matrix={};
 files.forEach(f=>{
  const m=f.name.match(/S(\d+)[^\d]?E(\d+)/i);
  if(!m)return;
  const s=+m[1],e=+m[2];
  matrix[s]??={};
  matrix[s][e]??={files:[]};
  matrix[s][e].files.push(f);
 });
 if(!Object.keys(matrix).length)
  return this.play(t.magnet,t.title);
 this.renderSeasons(matrix,t);
};

UATorrent.prototype.renderSeasons=function(matrix,t){
 const w=$('<div class="online-list"></div>');
 Object.keys(matrix).forEach(s=>{
  const el=$(`<div class="online-list__item selector">
   <div class="online-list__title">Сезон ${s}</div>
  </div>`);
  el.on('hover:enter',()=>this.renderEpisodes(matrix,s,t));
  w.append(el);
 });
 this.html.html(w);
 Lampa.Controller.collectionSet(w);
 Lampa.Controller.make(w);
};

UATorrent.prototype.renderEpisodes=function(matrix,s,t){
 const w=$('<div class="online-list"></div>');
 const p=loadProg(this.card);
 Object.keys(matrix[s]).forEach(e=>{
  const watched=p&&s==p.season&&e<=p.episode;
  const el=$(`<div class="online-list__item selector${watched?' watched':''}">
   <div class="online-list__title">Серія ${e}</div>
  </div>`);
  el.on('hover:enter',()=>this.playEpisode(matrix,s,e,t));
  w.append(el);
 });
 this.html.html(w);
 Lampa.Controller.collectionSet(w);
 Lampa.Controller.make(w);
};

UATorrent.prototype.playEpisode=function(matrix,s,e,t){
 const files=matrix[s][e].files;
 const pref=loadTorrentFile(this.card);
 let f=files.find(x=>x.index===pref)||files[0];
 saveTorrentFile(this.card,f.index);
 const r=loadTime(this.card,s,e);

 Lampa.Player.play({
  url:this.settings.torrserver+
   '/stream?link='+encodeURIComponent(t.magnet)+'&index='+f.index,
  title:`${t.title} — С${s}Е${e}`,
  time:r&&r.time>30?r.time:0,
  ontime:x=>saveTime(this.card,s,e,x),
  onpause:x=>saveTime(this.card,s,e,x),
  onended:()=>{
   saveProg(this.card,s,e);
   if(this.settings.autoplay)this.next(matrix,s,e,t);
  }
 });
};

UATorrent.prototype.next=function(matrix,s,e,t){
 const eps=Object.keys(matrix[s]).map(Number);
 const i=eps.indexOf(+e);
 if(i<eps.length-1)
  return this.playEpisode(matrix,s,eps[i+1],t);
 const ss=Object.keys(matrix).map(Number);
 const si=ss.indexOf(+s);
 if(si<ss.length-1){
  const ns=ss[si+1];
  const ne=Object.keys(matrix[ns])[0];
  this.playEpisode(matrix,ns,ne,t);
 }
};

UATorrent.prototype.play=function(m,title){
 Lampa.Player.play({
  url:this.settings.torrserver+
   '/stream?link='+encodeURIComponent(m),
  title:title
 });
};

UATorrent.prototype.empty=function(){
 this.html.html('<div class="empty"><h3>Нічого не знайдено</h3></div>');
};

Lampa.Component.add('ua_torrent',UATorrent);

/* ======================================================
 * SETTINGS COMPONENT
 * ====================================================== */

function UASettings(){
 this.s=loadSettings();
 this.html=$('<div></div>');
}

UASettings.prototype.create=function(){
 const w=$('<div class="online-list"></div>');
 const add=(t,v,cb)=>{
  const el=$(`<div class="online-list__item selector">
   <div class="online-list__title">${t}</div>
   <div class="online-list__quality">${v||''}</div>
  </div>`);
  el.on('hover:enter',cb);
  w.append(el);
 };

 add('Якість за замовчуванням',this.s.quality,()=>{
  this.pick(['auto','720p','1080p','2160p'],v=>{
   this.s.quality=v;saveSettings(this.s);this.create();
  });
 });

 add('Автоперехід',this.s.autoplay?'ON':'OFF',()=>{
  this.s.autoplay=!this.s.autoplay;saveSettings(this.s);this.create();
 });

 add('Очистити кеш торентів','',()=>{
  clearAllTorrentCache();
  Lampa.Noty.show('Кеш очищено');
 });

 this.html.html(w);
 Lampa.Controller.collectionSet(w);
 Lampa.Controller.make(w);
 return this.html;
};

UASettings.prototype.pick=function(list,cb){
 const w=$('<div></div>');
 list.forEach(v=>{
  const el=$(`<div class="online-list__item selector">${v}</div>`);
  el.on('hover:enter',()=>{Lampa.Modal.close();cb(v);});
  w.append(el);
 });
 Lampa.Modal.open({title:'Оберіть',html:w});
};

Lampa.Component.add('ua_settings',UASettings);

/* ======================================================
 * BUTTONS
 * ====================================================== */

setInterval(()=>{
 const c=$('.full-start-new__buttons,.full-start__buttons');
 if(!c.length||$('.ua-cinema-btn').length)return;

 c.prepend(`
  <div class="full-start__button selector ua-cinema-btn">🇺🇦 UA Online</div>
  <div class="full-start__button selector ua-torrent-btn">🇺🇦 Torrent Online</div>
  <div class="full-start__button selector ua-settings-btn">⚙ UA</div>
 `);

 $('.ua-cinema-btn').on('click',()=>{
  const a=Lampa.Activity.active();
  if(a&&a.card)
   Lampa.Activity.push({title:'UA Online',component:'ua_online',card:a.card});
 });

 $('.ua-torrent-btn').on('click',()=>{
  const a=Lampa.Activity.active();
  if(a&&a.card)
   Lampa.Activity.push({title:'Torrent Online',component:'ua_torrent',card:a.card});
 });

 $('.ua-settings-btn').on('click',()=>{
  Lampa.Activity.push({title:'UA Cinema',component:'ua_settings'});
 });
},1000);

})();

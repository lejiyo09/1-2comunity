

(function(){
  "use strict";

  const mixtapeRoot = document.getElementById('mixtape-app-root');

  /** @type {{id:number, blob:Blob, url:string, name:string, duration:number, order:number}[]} */
  let playlist = [];
  let playlists = []; // {id, name, order, createdAt}
  let currentPlaylistId = null;
  let currentIndex = -1;
  // 1-2 Music: "클릭하면 바로 재생"(playAdHoc)으로 재생 중일 때는 true. 기존 재생목록(currentIndex)과는
  // 별개로 관리해서, 재생/일시정지 버튼이 엉뚱하게 재생목록 0번 곡을 시작해버리는 문제를 막는다.
  let isAdHocPlaying = false;
  let adHocName = null;
  let adHocArtwork = null;
  // 1-2 Music: "내 음악"에서 재생한 곡이 끝났을 때 다음 곡(랜덤 등)을 골라주는 함수.
  // playAdHoc(공유 음악 등 다른 임시재생)에서는 쓰지 않으므로, playAdHoc을 부르면 항상 초기화된다.
  let adHocAutoNextProvider = null;
  let isShuffle = false;
  let repeatMode = 0; // 0 off, 1 repeat-all, 2 repeat-one
  let dragSrcIndex = null;
  let dbReady = false;

  const audio = new Audio();
  audio.preload = "metadata";

  // Media Session API: OS/브라우저의 시스템 미디어 위젯(알림창, 잠금화면, 키보드 미디어키 등)에
  // 곡 제목/앨범아트와 이전곡·다음곡 버튼이 뜨게 한다. 이걸 안 해두면 시스템 위젯이 그냥
  // 페이지 제목 + 재생/일시정지 버튼만 보여주는 기본 상태로 남는다 (다른 사이트들과 비교됐던 문제).
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => { if (audio.paused) togglePlay(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (!audio.paused) togglePlay(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('stop', () => { audio.pause(); audio.currentTime = 0; setPlayingState(false); });
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) audio.currentTime = details.seekTime;
      });
    } catch (e) { /* 일부 브라우저는 seekto 핸들러를 지원하지 않을 수 있다 - 무시 */ }
  }

  // 지금 재생 중인 곡의 제목/앨범아트를 Media Session 메타데이터로 반영한다.
  // updateNowPlaying()(일반 재생목록 곡 전환)과 playAdHoc(임시 재생) 양쪽에서 호출한다.
  let mediaSessionArtworkUrl = null;
  function updateMediaSessionMetadata(){
    if (!('mediaSession' in navigator)) return;
    let title, artworkBlob;
    if (isAdHocPlaying) {
      title = adHocName || '재생 중';
      artworkBlob = adHocArtwork || null;
    } else if (currentIndex >= 0 && playlist[currentIndex]) {
      title = playlist[currentIndex].name;
      artworkBlob = playlist[currentIndex].artwork || null;
    } else {
      navigator.mediaSession.metadata = null;
      return;
    }
    if (mediaSessionArtworkUrl) { URL.revokeObjectURL(mediaSessionArtworkUrl); mediaSessionArtworkUrl = null; }
    const artwork = [];
    if (artworkBlob) {
      mediaSessionArtworkUrl = URL.createObjectURL(artworkBlob);
      artwork.push({ src: mediaSessionArtworkUrl, sizes: '512x512', type: artworkBlob.type || 'image/png' });
    }
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: '1-2 Music', artwork });
  }

  // ---------- IndexedDB persistence ----------
  const DB_NAME = "mixtapeDB";
  const DB_VERSION = 3; // v3: 플레이리스트가 track을 직접 소유하지 않고 trackIds 배열로 "참조"한다 (Blob 복사 제거)
  let dbPromise = null;

  function openDB(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if(!window.indexedDB){ reject(new Error("IndexedDB not supported")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;

        let tracksStore;
        if(!db.objectStoreNames.contains("tracks")){
          tracksStore = db.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
          tracksStore.createIndex("order", "order", { unique: false });
        } else {
          tracksStore = tx.objectStore("tracks");
        }
        if(!tracksStore.indexNames.contains("playlistId")){
          tracksStore.createIndex("playlistId", "playlistId", { unique: false });
        }

        let playlistsStore;
        if(!db.objectStoreNames.contains("playlists")){
          playlistsStore = db.createObjectStore("playlists", { keyPath: "id", autoIncrement: true });
          playlistsStore.createIndex("order", "order", { unique: false });
        } else {
          playlistsStore = tx.objectStore("playlists");
        }

        if(event.oldVersion < 2){
          const addReq = playlistsStore.add({ name: "플레이리스트 1", order: 0, createdAt: Date.now() });
          addReq.onsuccess = () => {
            const defaultId = addReq.result;
            const cursorReq = tracksStore.openCursor();
            cursorReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if(cursor){
                const rec = cursor.value;
                if(rec.playlistId == null){
                  rec.playlistId = defaultId;
                  cursor.update(rec);
                }
                cursor.continue();
              }
            };
          };
        }

        // v3 migration: 기존 "각 track이 playlistId를 직접 들고 있는" 구조를,
        // "playlist가 trackIds 배열로 track을 참조하는" 구조로 바꾼다.
        // ⚠️ 기존 track 레코드(blob 포함)는 전혀 건드리지 않는다 - playlistId/order 필드가
        // 남아있어도 무해하다 (더 이상 읽지 않을 뿐). idempotent하게 만들어서, 이미 v3로
        // 넘어온 DB에 다시 실행돼도 trackIds가 중복 생성되지 않는다.
        if(event.oldVersion < 3){
          const playlistsCursorReq = playlistsStore.openCursor();
          playlistsCursorReq.onsuccess = (e) => {
            const pCursor = e.target.result;
            if(!pCursor){ return; }
            const playlistRec = pCursor.value;
            if(Array.isArray(playlistRec.trackIds)){
              // 이미 migration된 플레이리스트(trackIds가 이미 있음)는 건드리지 않는다 (idempotent 보장)
              pCursor.continue();
              return;
            }
            const idx = tracksStore.index("playlistId");
            const tCursorReq = idx.openCursor(IDBKeyRange.only(playlistRec.id));
            const collected = [];
            tCursorReq.onsuccess = (ev) => {
              const tCursor = ev.target.result;
              if(tCursor){
                collected.push({ id: tCursor.primaryKey, order: tCursor.value.order ?? 0 });
                tCursor.continue();
              } else {
                collected.sort((a, b) => a.order - b.order);
                playlistRec.trackIds = collected.map(c => c.id);
                pCursor.update(playlistRec);
                pCursor.continue();
              }
            };
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbGetAllPlaylists(){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readonly");
      const req = tx.objectStore("playlists").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAddPlaylist(name){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const req = tx.objectStore("playlists").add({ name, order: Date.now(), createdAt: Date.now(), trackIds: [] });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeletePlaylistCascade(playlistId){
    // v3: 이름은 "Cascade"지만 더 이상 tracks를 연쇄 삭제하지 않는다. 플레이리스트 레코드(=trackIds 참조 목록)만
    // 지운다. 실제 음악(tracks)은 다른 플레이리스트가 같은 곡을 참조하고 있을 수 있어 그대로 둔다.
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["playlists"], "readwrite");
      tx.objectStore("playlists").delete(playlistId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbClearTracksForPlaylist(playlistId){
    // v3: 이 플레이리스트의 trackIds만 비운다. tracks(실제 음악)는 삭제하지 않는다 (내 음악에 그대로 남음).
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const store = tx.objectStore("playlists");
      const getReq = store.get(playlistId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if(!rec){ resolve(); return; }
        rec.trackIds = [];
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function dbGetTracksByPlaylist(playlistId){
    // v3: playlist.trackIds 배열을 순서대로 읽어서, 각 id의 실제 track(blob 포함)을 tracks에서 조회한다.
    // 반환값에는 기존 호출부(switchPlaylist)가 기대하는 order 필드를 배열 위치로 합성해서 채워준다 -
    // 그래야 switchPlaylist 등 기존 재생 엔진 코드를 전혀 안 건드려도 그대로 동작한다.
    const db = await openDB();
    const playlistRec = await new Promise((resolve, reject) => {
      const req = db.transaction("playlists", "readonly").objectStore("playlists").get(playlistId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const trackIds = (playlistRec && Array.isArray(playlistRec.trackIds)) ? playlistRec.trackIds : [];
    if(trackIds.length === 0) return [];

    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", "readonly");
      const store = tx.objectStore("tracks");
      const results = [];
      let pending = trackIds.length;
      let hadError = false;
      trackIds.forEach((id, order) => {
        const req = store.get(id);
        req.onsuccess = () => {
          if(req.result) results.push({ ...req.result, order }); // 원본 트랙 필드 + 이 플레이리스트에서의 순서
          pending--;
          if(pending === 0 && !hadError) resolve(results);
        };
        req.onerror = () => {
          hadError = true;
          reject(req.error);
        };
      });
    });
  }

  async function dbAddTrack(record){
    // v3: record는 예전과 같은 모양({playlistId, name, blob, order, sourceType})으로 받지만,
    // 실제로는 (1) tracks에 blob을 "한 번만" 저장하고 (2) 그 track id를 지정된 playlist의
    // trackIds 끝에 추가하는 두 단계로 나눠서 처리한다. 호출부(addFiles 등)는 전혀 안 바뀐다.
    const db = await openDB();
    const trackId = await new Promise((resolve, reject) => {
      const req = db.transaction("tracks", "readwrite").objectStore("tracks").add({
        name: record.name,
        blob: record.blob,
        sourceType: record.sourceType || 'local',
        createdAt: Date.now()
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if(record.playlistId != null){
      await dbAddTrackRefToPlaylist(record.playlistId, trackId);
    }
    return trackId;
  }

  // v3 신규: 이미 tracks에 있는 곡(blob 복사 없이)을 다른 플레이리스트에 "참조"로 추가한다.
  // 같은 곡이 이미 그 플레이리스트에 있으면 중복 추가하지 않는다 (조용히 무시).
  async function dbAddTrackRefToPlaylist(playlistId, trackId){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const store = tx.objectStore("playlists");
      const getReq = store.get(playlistId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if(!rec){ resolve(false); return; }
        if(!Array.isArray(rec.trackIds)) rec.trackIds = [];
        if(rec.trackIds.includes(trackId)){ resolve(false); return; } // 이미 있으면 중복 추가 안 함
        rec.trackIds.push(trackId);
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // 아래 둘은 "보기 전용" 화면(재생 중이 아닌 다른 플레이리스트를 열었을 때) 전용이다.
  // persistOrder/dbDeleteTrack은 currentPlaylistId(=지금 재생 중인 플레이리스트)를 암묵적으로 쓰기
  // 때문에, 재생 중이 아닌 플레이리스트를 잘못 건드리지 않도록 playlistId를 명시로 받는 버전을 따로 둔다.
  async function dbUpdateTrackOrderForPlaylist(playlistId, orderedTrackIds){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const store = tx.objectStore("playlists");
      const getReq = store.get(playlistId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if(!rec){ resolve(); return; }
        rec.trackIds = orderedTrackIds;
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function dbRemoveTrackRefFromPlaylist(playlistId, trackId){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const store = tx.objectStore("playlists");
      const getReq = store.get(playlistId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if(!rec || !Array.isArray(rec.trackIds)){ resolve(); return; }
        rec.trackIds = rec.trackIds.filter(tid => tid !== trackId);
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function dbDeleteTrack(id){
    // v3: 이름은 예전 그대로지만 의미가 바뀌었다 - "내 음악(tracks)에서 영구 삭제"가 아니라
    // "현재 열려 있는 플레이리스트에서만 이 곡의 참조를 제거"한다. 다른 플레이리스트나 "내 음악"
    // 전체 목록에는 그대로 남는다 (문서 10번: 플레이리스트 삭제/트랙 제거가 다른 곳의 곡을
    // 지우면 안 된다는 원칙과 동일하게 적용).
    if(currentPlaylistId == null) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("playlists", "readwrite");
      const store = tx.objectStore("playlists");
      const getReq = store.get(currentPlaylistId);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if(!rec || !Array.isArray(rec.trackIds)){ resolve(); return; }
        rec.trackIds = rec.trackIds.filter(tid => tid !== id);
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function dbUpdateTrackOrder(id, order){
    // v3에서는 더 이상 track 레코드 자체에 order를 저장하지 않는다 (persistOrder가 플레이리스트의
    // trackIds 배열 순서로 한 번에 저장한다). 다른 곳에서 호출하는 곳이 없어 안전하게 no-op으로 둔다.
  }

  async function persistOrder(){
    if(!dbReady || currentPlaylistId == null) return;
    try{
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("playlists", "readwrite");
        const store = tx.objectStore("playlists");
        const getReq = store.get(currentPlaylistId);
        getReq.onsuccess = () => {
          const rec = getReq.result;
          if(!rec){ resolve(); return; }
          // 아직 DB에 저장되지 않은(추가 중인) 트랙은 id가 null일 수 있어 제외한다
          rec.trackIds = playlist.filter(t => t.id != null).map(t => t.id);
          const putReq = store.put(rec);
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    }catch(err){ console.warn("순서 저장 실패", err); }
  }

  function probeDuration(entry){
    const probe = new Audio();
    probe.preload = "metadata";
    probe.src = entry.url;
    probe.addEventListener("loadedmetadata", () => {
      entry.duration = probe.duration;
      renderList();
    }, { once:true });
  }

  // ---------- Embedded lyrics (ID3v2 USLT) reader ----------
  // Reads only lyrics tags already embedded in the user's own local file — never
  // fetches or generates lyrics text from anywhere else.
  function readSyncSafeInt(bytes, offset){
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset+1] & 0x7f) << 14) |
           ((bytes[offset+2] & 0x7f) << 7) | (bytes[offset+3] & 0x7f);
  }
  function readInt32(bytes, offset){
    return ((bytes[offset] << 24) | (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3]) >>> 0;
  }

  function decodeId3Text(bytes, encodingByte){
    try{
      if(encodingByte === 0) return new TextDecoder("iso-8859-1").decode(bytes);
      if(encodingByte === 3) return new TextDecoder("utf-8").decode(bytes);
      if(encodingByte === 1){
        if(bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.slice(2));
        if(bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.slice(2));
        return new TextDecoder("utf-16le").decode(bytes);
      }
      if(encodingByte === 2) return new TextDecoder("utf-16be").decode(bytes);
    }catch(e){ /* fall through */ }
    return null;
  }

  function decodeUSLT(frameData){
    if(frameData.length < 5) return null;
    const encodingByte = frameData[0];
    const isUtf16 = (encodingByte === 1 || encodingByte === 2);
    let descEnd = 4; // skip encoding byte(1) + language code(3)
    if(isUtf16){
      while(descEnd + 1 < frameData.length && !(frameData[descEnd] === 0 && frameData[descEnd+1] === 0)) descEnd += 2;
      descEnd += 2;
    } else {
      while(descEnd < frameData.length && frameData[descEnd] !== 0) descEnd += 1;
      descEnd += 1;
    }
    if(descEnd >= frameData.length) return null;
    const text = decodeId3Text(frameData.slice(descEnd), encodingByte);
    return text ? text.trim() : null;
  }

  async function extractEmbeddedLyrics(blob){
    try{
      const headerBuf = await blob.slice(0, 10).arrayBuffer();
      const header = new Uint8Array(headerBuf);
      if(String.fromCharCode(header[0], header[1], header[2]) !== "ID3") return null;
      const majorVersion = header[3];
      const tagSize = readSyncSafeInt(header, 6);
      if(tagSize <= 0) return null;
      const bodyBuf = await blob.slice(10, 10 + tagSize).arrayBuffer();
      const body = new Uint8Array(bodyBuf);
      let offset = 0;
      while(offset + 10 <= body.length){
        const frameId = String.fromCharCode(body[offset], body[offset+1], body[offset+2], body[offset+3]);
        if(frameId === "\0\0\0\0") break;
        const frameSize = majorVersion >= 4 ? readSyncSafeInt(body, offset+4) : readInt32(body, offset+4);
        const frameStart = offset + 10;
        if(frameSize <= 0 || frameStart + frameSize > body.length) break;
        if(frameId === "USLT"){
          const lyrics = decodeUSLT(body.slice(frameStart, frameStart + frameSize));
          if(lyrics) return lyrics;
        }
        offset = frameStart + frameSize;
      }
      return null;
    }catch(err){
      console.warn("가사 태그를 읽지 못했어요", err);
      return null;
    }
  }

  function ensureLyrics(entry){
    if(entry.lyricsChecked) return;
    entry.lyricsChecked = true;
    extractEmbeddedLyrics(entry.blob).then(lyrics => {
      entry.lyrics = lyrics;
      if(currentIndex !== -1 && playlist[currentIndex] === entry) renderIpodScreen();
    });
  }

  const $ = (id) => document.getElementById(id);
  const fileInput = $("fileInput");
  const dropzone = $("dropzone");
  const trackListEl = $("trackList");
  const playBtn = $("playBtn");
  const prevBtn = $("prevBtn");
  const nextBtn = $("nextBtn");
  const shuffleBtn = $("shuffleBtn");
  const repeatBtn = $("repeatBtn");
  const seek = $("seek");
  const curTimeEl = $("curTime");
  const durTimeEl = $("durTime");
  const npTitle = $("npTitle");
  const npSub = $("npSub");
  const statusText = $("statusText");
  const trackCountEl = $("trackCount");
  const volumeEl = $("volume");
  const clearAllBtn = $("clearAllBtn");
  const shuffleOrderBtn = $("shuffleOrderBtn");
  const reverseOrderBtn = $("reverseOrderBtn");
  const sideLabel = $("sideLabel");
  const trackPreviewEl = $("trackPreview");
  const sideTabEl = $("sideTab");
  const playlistDrawerEl = $("playlistDrawer");
  const drawerListEl = $("drawerList");
  const newPlaylistBtnEl = $("newPlaylistBtn");
  const themeCassetteBtn = $("themeCassetteBtn");
  const themeIpodBtn = $("themeIpodBtn");
  const ipodPlaylistName = $("ipodPlaylistName");
  const ipodScreenBody = $("ipodScreenBody");
  const ipodTimeCur = $("ipodTimeCur");
  const ipodTimeDur = $("ipodTimeDur");
  const ipodProgressFill = $("ipodProgressFill");
  const wheelMenu = $("wheelMenu");
  const wheelPrev = $("wheelPrev");
  const wheelNext = $("wheelNext");
  const wheelPlay = $("wheelPlay");
  const wheelCenter = $("wheelCenter");
  let ipodScreenMode = "now"; // "now" | "lyric"

  audio.volume = parseFloat(volumeEl.value);

  function formatTime(sec){
    if(!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec/60);
    const s = Math.floor(sec%60).toString().padStart(2,"0");
    return `${m}:${s}`;
  }

  function stripExt(name){
    return name.replace(/\.[^/.]+$/, "");
  }

  // ---------- Theme switching (cassette / iPod) ----------
  function layoutLyricLines(text){
    const words = (text || "").split(/\s+/).filter(Boolean);
    if(words.length === 0) return [{ text: "NO SONG", align: "left" }];
    const lines = [];
    let i = 0;
    let alignLeft = true;
    while(i < words.length){
      const take = alignLeft ? Math.min(2, words.length - i) : 1;
      lines.push({ text: words.slice(i, i + take).join(" "), align: alignLeft ? "left" : "right" });
      i += take;
      alignLeft = !alignLeft;
    }
    return lines;
  }

  function renderIpodScreen(){
    if(!ipodScreenBody) return;
    ipodScreenBody.innerHTML = "";
    const hasTrack = currentIndex !== -1 && playlist[currentIndex];
    if(ipodScreenMode === "lyric" && hasTrack){
      const track = playlist[currentIndex];
      const wrap = document.createElement("div");
      wrap.className = "ipod-lyric";
      if(track.lyrics){
        track.lyrics.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean).forEach((line, i) => {
          const div = document.createElement("div");
          div.style.textAlign = i % 2 === 0 ? "left" : "right";
          div.textContent = line;
          wrap.appendChild(div);
        });
      } else {
        layoutLyricLines(track.name).forEach(line => {
          const div = document.createElement("div");
          div.style.textAlign = line.align;
          div.textContent = line.text;
          wrap.appendChild(div);
        });
      }
      ipodScreenBody.appendChild(wrap);
    } else {
      const title = document.createElement("div");
      title.className = "ipod-now-title";
      title.textContent = hasTrack ? playlist[currentIndex].name : "NO SONG SELECTED";
      const sub = document.createElement("div");
      sub.className = "ipod-now-sub";
      sub.textContent = hasTrack ? `${currentIndex + 1} OF ${playlist.length}` : "READY";
      ipodScreenBody.appendChild(title);
      ipodScreenBody.appendChild(sub);
    }
  }

  function setIpodPlaying(playing){
    if(!wheelPlay) return;
    wheelPlay.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }

  function applyTheme(theme){
    mixtapeRoot.classList.toggle("theme-ipod", theme === "ipod");
    if(themeCassetteBtn) themeCassetteBtn.classList.toggle("active", theme !== "ipod");
    if(themeIpodBtn) themeIpodBtn.classList.toggle("active", theme === "ipod");
    try{ localStorage.setItem("mixtape_theme", theme); }catch(e){}
    if(theme === "ipod") renderIpodScreen();
  }

  if(themeCassetteBtn) themeCassetteBtn.addEventListener("click", () => applyTheme("cassette"));
  if(themeIpodBtn) themeIpodBtn.addEventListener("click", () => applyTheme("ipod"));
  if(ipodScreenBody){
    ipodScreenBody.addEventListener("click", () => {
      ipodScreenMode = ipodScreenMode === "now" ? "lyric" : "now";
      renderIpodScreen();
    });
  }
  if(wheelPlay) wheelPlay.addEventListener("click", () => togglePlay());
  if(wheelCenter) wheelCenter.addEventListener("click", () => togglePlay());
  if(wheelPrev) wheelPrev.addEventListener("click", () => prevTrack());
  if(wheelNext) wheelNext.addEventListener("click", () => nextTrack(false));
  if(wheelMenu) wheelMenu.addEventListener("click", () => playlistDrawerEl.classList.toggle("open"));

  let savedTheme = null;
  try{ savedTheme = localStorage.getItem("mixtape_theme"); }catch(e){}
  applyTheme(savedTheme === "ipod" ? "ipod" : "cassette");

  // ---------- Playlist management ----------
  function updateTapeLabel(){
    const cur = playlists.find(p => p.id === currentPlaylistId);
    sideLabel.textContent = cur ? cur.name : "플레이리스트";
    if(ipodPlaylistName) ipodPlaylistName.textContent = cur ? cur.name : "플레이리스트";
  }

  function renderDrawer(){
    drawerListEl.innerHTML = "";
    playlists.forEach(p => {
      const item = document.createElement("div");
      item.className = "drawer-item" + (p.id === currentPlaylistId ? " active" : "");

      const reels = document.createElement("div");
      reels.className = "mini-reels";
      reels.innerHTML = '<span class="mini-reel"></span><span class="mini-reel"></span>';

      const name = document.createElement("div");
      name.className = "drawer-name";
      name.textContent = p.name;

      const del = document.createElement("button");
      del.className = "drawer-del";
      del.title = "삭제";
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deletePlaylist(p.id, p.name);
      });

      item.appendChild(reels);
      item.appendChild(name);
      item.appendChild(del);
      item.addEventListener("click", () => {
        if(p.id !== currentPlaylistId) switchPlaylist(p.id);
        else closeDrawer();
      });

      drawerListEl.appendChild(item);
    });
  }

  async function createNewPlaylist(){
    const suggested = `플레이리스트 ${playlists.length + 1}`;
    const name = prompt("새 플레이리스트 이름을 입력하세요", suggested);
    if(name === null) return;
    const trimmed = name.trim() || suggested;
    try{
      const id = await dbAddPlaylist(trimmed);
      playlists.push({ id, name: trimmed, order: Date.now(), createdAt: Date.now() });
      dbReady = true;
      // 다른 플레이리스트의 곡이 재생 중이면 방금 만든(비어있는) 플레이리스트로 전환하지 않는다 -
      // switchPlaylist()는 항상 재생을 멈추기 때문에, 새 플레이리스트를 만들기만 했는데 듣던 음악이
      // 끊기면 안 된다. 재생 중이 아닐 때는 기존처럼 바로 전환한다.
      const isPlaying = mixtapeRoot ? mixtapeRoot.classList.contains('playing') : false;
      if (isPlaying) {
        renderDrawer();
      } else {
        await switchPlaylist(id);
      }
    }catch(err){
      alert("플레이리스트를 만들지 못했어요.");
      console.warn(err);
    }
  }

  async function deletePlaylist(id, name){
    if(playlists.length <= 1){
      alert("마지막 남은 플레이리스트는 삭제할 수 없어요.");
      return;
    }
    if(!confirm(`"${name}" 플레이리스트를 삭제할까요? 안에 있는 곡도 함께 삭제돼요.`)) return;
    try{
      await dbDeletePlaylistCascade(id);
    }catch(err){ console.warn("플레이리스트 삭제 실패", err); }
    playlists = playlists.filter(p => p.id !== id);
    if(currentPlaylistId === id){
      await switchPlaylist(playlists[0].id);
    } else {
      renderDrawer();
    }
  }

  async function switchPlaylist(id){
    audio.pause();
    audio.src = "";
    playlist.forEach(t => URL.revokeObjectURL(t.url));
    playlist = [];
    currentIndex = -1;
    currentPlaylistId = id;
    try{ localStorage.setItem("mixtape_currentPlaylistId", String(id)); }catch(e){}

    updateTapeLabel();
    updateNowPlaying();
    setPlayingState(false);
    renderList();
    renderDrawer();
    closeDrawer();

    if(id == null) return;
    try{
      const records = await dbGetTracksByPlaylist(id);
      records.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
      records.forEach(rec => {
        const url = URL.createObjectURL(rec.blob);
        const entry = { id: rec.id, blob: rec.blob, url, name: rec.name, duration: null, order: rec.order, artwork: rec.artwork || null };
        playlist.push(entry);
        probeDuration(entry);
      });
      renderList();
      statusText.textContent = playlist.length ? `저장된 ${playlist.length}곡 불러옴` : "준비됨";
    }catch(err){
      console.warn("트랙을 불러오지 못했어요:", err);
    }
  }

  // "내 음악"에서 곡을 이 플레이리스트에 추가했을 때 화면에 즉시 반영하기 위한 용도.
  // switchPlaylist()는 항상 재생을 멈추고 처음부터 다시 불러오므로, 지금 이 플레이리스트를 재생
  // 중일 때 그대로 쓰면 음악이 끊긴다. 대신 이미 있던 곡의 entry(같은 blob url)는 그대로 재사용하고
  // 새로 추가된 곡만 새 entry를 만들어서, 재생 중인 곡의 currentIndex만 다시 찾아 갱신한다.
  async function refreshCurrentPlaylistTracks(){
    if (currentPlaylistId == null) return;
    try{
      const records = await dbGetTracksByPlaylist(currentPlaylistId);
      records.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
      const existingById = new Map(playlist.map(e => [e.id, e]));
      const newPlaylist = records.map(rec => {
        const existing = existingById.get(rec.id);
        if (existing) return { ...existing, order: rec.order };
        const url = URL.createObjectURL(rec.blob);
        const entry = { id: rec.id, blob: rec.blob, url, name: rec.name, duration: null, order: rec.order, artwork: rec.artwork || null };
        probeDuration(entry);
        return entry;
      });
      const newIds = new Set(newPlaylist.map(e => e.id));
      playlist.forEach(e => { if (!newIds.has(e.id) && e.url) URL.revokeObjectURL(e.url); });
      const currentTrackId = (currentIndex >= 0 && playlist[currentIndex]) ? playlist[currentIndex].id : null;
      playlist = newPlaylist;
      currentIndex = currentTrackId != null ? playlist.findIndex(e => e.id === currentTrackId) : -1;
      renderList();
    }catch(err){
      console.warn("플레이리스트 갱신 실패:", err);
    }
  }

  async function initPlaylists(){
    try{
      let pls = await dbGetAllPlaylists();
      dbReady = true;
      if(pls.length === 0){
        const id = await dbAddPlaylist("플레이리스트 1");
        pls = [{ id, name: "플레이리스트 1", order: 0, createdAt: Date.now() }];
      }
      pls.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
      playlists = pls;
      renderDrawer();

      let savedId = null;
      try{ savedId = parseInt(localStorage.getItem("mixtape_currentPlaylistId"), 10); }catch(e){}
      const target = playlists.find(p => p.id === savedId) || playlists[0];
      await switchPlaylist(target.id);
    }catch(err){
      dbReady = false;
      console.warn("플레이리스트를 불러오지 못했어요 (이 세션에서만 사용됩니다):", err);
      playlists = [{ id: null, name: "플레이리스트 1" }];
      currentPlaylistId = null;
      updateTapeLabel();
      renderDrawer();
      renderList();
    }
  }

  function openDrawer(){ playlistDrawerEl.classList.add("open"); }
  function closeDrawer(){ playlistDrawerEl.classList.remove("open"); }

  sideTabEl.addEventListener("mouseenter", openDrawer);
  sideTabEl.addEventListener("click", () => playlistDrawerEl.classList.toggle("open"));
  playlistDrawerEl.addEventListener("mouseenter", openDrawer);
  playlistDrawerEl.addEventListener("mouseleave", closeDrawer);
  document.addEventListener("click", (e) => {
    if(!playlistDrawerEl.contains(e.target) && !sideTabEl.contains(e.target)){
      closeDrawer();
    }
  });
  newPlaylistBtnEl.addEventListener("click", createNewPlaylist);

  // ---------- Track management ----------
  async function addFiles(fileList){
    const files = Array.from(fileList).filter(f => f.type.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(f.name));
    if(files.length === 0) return;
    for(const file of files){
      const name = stripExt(file.name);
      const order = playlist.length;
      const url = URL.createObjectURL(file);
      const entry = { id: null, blob: file, url, name, duration: null, order };
      playlist.push(entry);
      renderList();
      probeDuration(entry);
      if(currentPlaylistId != null){
        try{
          const id = await dbAddTrack({ playlistId: currentPlaylistId, name, blob: file, order });
          entry.id = id;
          dbReady = true;
        }catch(err){
          console.warn("파일을 저장하지 못했어요 (이 세션에서만 재생됩니다):", err);
        }
      }
    }
    renderList();
    statusText.textContent = `${playlist.length}곡 준비됨`;
  }

  // 트랙과 트랙 사이의 "+" 버튼으로 추가할 때는 새 파일을 올리는 게 아니라 "내 음악"(이미 tracks
  // 스토어에 있는 곡)에서 골라 지정된 위치(insertIndex)에 참조로 끼워 넣는다. dbAddTrackRefToPlaylist는
  // 항상 trackIds 끝에 참조를 붙이므로, 실제 삽입 위치를 DB에도 반영하려면 매번 persistOrder()로 지금
  // 메모리상 playlist 순서를 다시 저장해줘야 한다. tracks는 {id, name, blob, ...} 레코드 배열(musicDbGetAllTracks
  // 결과)이고, 이미 이 플레이리스트에 있는 곡은 조용히 건너뛴다(중복 추가 방지).
  async function insertLibraryTracksAtIndex(tracks, insertIndex){
    if(!tracks || tracks.length === 0) return;
    let idx = Math.max(0, Math.min(insertIndex, playlist.length));
    for(const rec of tracks){
      if(playlist.some(t => t.id === rec.id)) continue;
      const url = URL.createObjectURL(rec.blob);
      const entry = { id: rec.id, blob: rec.blob, url, name: rec.name, duration: null, order: idx, artwork: rec.artwork || null };
      playlist.splice(idx, 0, entry);
      if(currentIndex >= idx) currentIndex++; // 삽입 지점보다 뒤(또는 그 자리)에 있던 재생 중인 곡의 인덱스가 밀린다
      renderList();
      probeDuration(entry);
      if(currentPlaylistId != null){
        try{
          await dbAddTrackRefToPlaylist(currentPlaylistId, rec.id);
          await persistOrder();
        }catch(err){
          console.warn("곡을 추가하지 못했어요:", err);
        }
      }
      idx++;
    }
    renderList();
    statusText.textContent = `${playlist.length}곡 준비됨`;
  }

  function triggerInsertAt(insertIndex){
    if(selectModeActive) return;
    if(window.openInsertFromLibraryModal) window.openInsertFromLibraryModal(insertIndex);
  }

  function renderTrackPreview(){
    if(!trackPreviewEl) return;
    trackPreviewEl.innerHTML = "";
    const base = currentIndex === -1 ? 0 : currentIndex;
    for(let offset = -2; offset <= 2; offset++){
      const idx = base + offset;
      const div = document.createElement("div");
      if(idx >= 0 && idx < playlist.length){
        div.className = "tp-item" + (idx === currentIndex ? " tp-current" : " tp-d" + Math.abs(offset));
        div.textContent = playlist[idx].name;
        div.addEventListener("click", () => playTrack(idx));
      } else {
        div.className = "tp-item tp-empty";
        div.innerHTML = "&nbsp;";
      }
      trackPreviewEl.appendChild(div);
    }
  }

  // 1-2 Music: 플레이리스트 "선택 모드" - 별도 화면을 새로 만들지 않고, 기존 트랙리스트 좌측에
  // 체크박스만 조건부로 붙인다. 선택 모드일 때는 클릭이 재생 대신 체크 토글로 동작한다.
  let selectModeActive = false;
  let selectedTrackIndices = new Set();

  function renderList(){
    trackCountEl.textContent = `${playlist.length}곡`;
    if(playlist.length === 0){
      trackListEl.innerHTML = `<li><div class="empty-state" style="width:100%;">아직 추가된 곡이 없어요</div></li>`;
      renderTrackPreview();
      return;
    }
    trackListEl.innerHTML = "";
    if(!selectModeActive) trackListEl.appendChild(createGapLi(0)); // 첫 곡 위에도 끼워 넣을 수 있게
    playlist.forEach((track, i) => {
      const li = document.createElement("li");
      li.draggable = !selectModeActive; // 선택 모드에서는 드래그 정렬 대신 체크에 집중
      li.dataset.index = i;
      if(i === currentIndex) li.classList.add("active");

      if(selectModeActive){
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "track-select-checkbox";
        checkbox.checked = selectedTrackIndices.has(i);
        checkbox.addEventListener("click", (e) => e.stopPropagation());
        checkbox.addEventListener("change", () => {
          if(checkbox.checked) selectedTrackIndices.add(i); else selectedTrackIndices.delete(i);
          if(window.onPlaylistSelectionChanged) window.onPlaylistSelectionChanged();
        });
        li.appendChild(checkbox);
      }

      const num = document.createElement("div");
      num.className = "track-num";
      num.textContent = (i+1).toString().padStart(2,"0");

      const info = document.createElement("div");
      info.className = "track-info";
      const nameEl = document.createElement("div");
      nameEl.className = "track-name";
      nameEl.textContent = track.name;
      info.appendChild(nameEl);

      const dur = document.createElement("div");
      dur.className = "track-dur";
      dur.textContent = track.duration ? formatTime(track.duration) : "--:--";

      const removeBtn = document.createElement("button");
      removeBtn.className = "track-remove";
      removeBtn.title = "이 플레이리스트에서 빼기";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTrack(i);
      });

      const moveWrap = document.createElement("div");
      moveWrap.className = "track-move";
      const upBtn = document.createElement("button");
      upBtn.textContent = "▲";
      upBtn.title = "위로 이동";
      upBtn.disabled = (i === 0);
      upBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveTrack(i, -1);
      });
      const downBtn = document.createElement("button");
      downBtn.textContent = "▼";
      downBtn.title = "아래로 이동";
      downBtn.disabled = (i === playlist.length - 1);
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveTrack(i, 1);
      });
      moveWrap.appendChild(upBtn);
      moveWrap.appendChild(downBtn);

      li.appendChild(num);
      li.appendChild(info);
      li.appendChild(dur);
      if(!selectModeActive){
        li.appendChild(moveWrap);
        li.appendChild(removeBtn);
      }

      li.addEventListener("click", () => {
        if(selectModeActive){
          // 선택 모드에서는 행 전체를 클릭해도 체크박스와 동일하게 토글된다 (체크박스만 정확히 누르지 않아도 됨)
          const cb = li.querySelector(".track-select-checkbox");
          if(cb){ cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
          return;
        }
        playTrack(i);
      });

      li.addEventListener("dragstart", () => {
        if(selectModeActive) return;
        dragSrcIndex = i;
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
      });
      li.addEventListener("dragover", (e) => e.preventDefault());
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        if(selectModeActive || dragSrcIndex === null || dragSrcIndex === i) return;
        const moved = playlist.splice(dragSrcIndex, 1)[0];
        playlist.splice(i, 0, moved);
        if(currentIndex === dragSrcIndex) currentIndex = i;
        else if(dragSrcIndex < currentIndex && i >= currentIndex) currentIndex--;
        else if(dragSrcIndex > currentIndex && i <= currentIndex) currentIndex++;
        dragSrcIndex = null;
        renderList();
        persistOrder();
      });

      trackListEl.appendChild(li);
      if(!selectModeActive) trackListEl.appendChild(createGapLi(i + 1)); // 이 곡과 다음 곡 사이
    });
    renderTrackPreview();
  }

  // 트랙과 트랙 사이(또는 맨 위)에 마우스를 잠시 올려두면 벌어지면서 "+" 버튼이 나타나는 얇은 삽입 지점.
  // 클릭하면 "내 음악"에서 골라 정확히 그 위치(insertIndex)에 끼워 넣는다 (insertLibraryTracksAtIndex 참고).
  function createGapLi(insertIndex){
    const gap = document.createElement("li");
    gap.className = "track-gap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "track-gap-add";
    btn.textContent = "+";
    btn.title = "여기에 곡 추가";
    gap.appendChild(btn);
    let hoverTimer = null;
    gap.addEventListener("mouseenter", () => {
      hoverTimer = setTimeout(() => gap.classList.add("open"), 350);
    });
    gap.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      gap.classList.remove("open");
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerInsertAt(insertIndex);
    });
    return gap;
  }

  function removeTrack(i){
    const wasCurrent = (i === currentIndex);
    const removed = playlist[i];
    URL.revokeObjectURL(removed.url);
    if(removed.id != null){
      dbDeleteTrack(removed.id).catch(err => console.warn("삭제 저장 실패", err));
    }
    playlist.splice(i, 1);
    if(wasCurrent){
      audio.pause();
      audio.src = "";
      currentIndex = -1;
      updateNowPlaying();
      setPlayingState(false);
    } else if(i < currentIndex){
      currentIndex--;
    }
    renderList();
  }

  // 선택 모드에서 체크된 여러 곡을 한 번에 삭제한다. 기존에 검증된 removeTrack()을 그대로
  // 재사용하되, 인덱스가 낮아지는 순서를 피하려고 "높은 인덱스부터" 순서대로 지운다.
  function removeSelectedTracks(indices){
    const sorted = Array.from(indices).sort((a, b) => b - a);
    sorted.forEach(i => removeTrack(i));
  }

  function moveTrack(i, dir){
    const j = i + dir;
    if(j < 0 || j >= playlist.length) return;
    [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
    if(currentIndex === i) currentIndex = j;
    else if(currentIndex === j) currentIndex = i;
    renderList();
    persistOrder();
  }

  // 1-2 Music: playAdHoc/playAdHocWithAutoNext가 공유하는 실제 재생 로직.
  // nextProviderFn이 있으면(=내 음악에서 재생), 곡이 끝났을 때 그 provider로 다음 곡을 이어 재생한다.
  function startAdHocPlayback(url, name, artwork, nextProviderFn){
    try {
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      audio.play();
      isAdHocPlaying = true;
      adHocName = name || null;
      adHocArtwork = artwork || null;
      adHocAutoNextProvider = nextProviderFn || null;
      if (mixtapeRoot) mixtapeRoot.classList.add('playing');
      updateMediaSessionMetadata();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      notifyMiniWidgetMixtape();
    } catch (e) { console.warn('1-2 Music 임시 재생 실패:', e); }
  }

  function playTrack(i){
    if(i < 0 || i >= playlist.length) return;
    isAdHocPlaying = false; // 실제 재생목록 곡을 선택했으니 임시재생 모드는 해제한다
    adHocAutoNextProvider = null;
    currentIndex = i;
    const track = playlist[i];
    audio.src = track.url;
    audio.play().then(() => {
      setPlayingState(true);
      if (window.completeDailyMission) window.completeDailyMission('mixtape', 20, 'MixTape 재생');
    }).catch(() => setPlayingState(false));
    updateNowPlaying();
    renderList();
    ensureLyrics(track);
    if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
  }

  function updateNowPlaying(){
    if(currentIndex === -1){
      npTitle.textContent = "재생할 곡을 선택하세요";
      npSub.textContent = "대기 중";
      renderIpodScreen();
      updateMediaSessionMetadata();
      return;
    }
    const track = playlist[currentIndex];
    npTitle.textContent = track.name;
    npSub.textContent = `${currentIndex+1} / ${playlist.length}곡`;
    renderIpodScreen();
    updateMediaSessionMetadata();
  }

  function setPlayingState(playing){
    mixtapeRoot.classList.toggle("playing", playing);
    playBtn.textContent = playing ? "⏸" : "▶";
    statusText.textContent = playing ? "재생 중" : (currentIndex === -1 ? "준비됨" : "일시정지");
    setIpodPlaying(playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function togglePlay(){
    if(isAdHocPlaying){
      if(audio.paused){ audio.play().then(() => setPlayingState(true)); }
      else { audio.pause(); setPlayingState(false); }
      if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
      return;
    }
    if(currentIndex === -1){
      if(playlist.length > 0) playTrack(0);
      return;
    }
    if(audio.paused){
      audio.play().then(() => setPlayingState(true));
    } else {
      audio.pause();
      setPlayingState(false);
    }
    if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
  }

  // 1-2 Music: "내 음악" 다음 곡 랜덤 재생 체인에서 실제로 다음 곡을 고르고 이어 재생한다.
  // audio의 'ended' 이벤트뿐 아니라 nextTrack()에서도 반드시 이 경로를 타야 한다 - 그렇지 않으면
  // (예: PiP/인라인 위젯의 "다음 곡" 버튼, 키보드/시스템 미디어키의 다음곡) 곧바로 일반 재생목록
  // 로직으로 빠져서, 예전에 열어봤던 플레이리스트가 메모리에 남아있으면 갑자기 그 플레이리스트
  // 순서로 재생이 바뀌어버리는 버그가 생긴다.
  function advanceMyMusicAutoNext(){
    const provider = adHocAutoNextProvider;
    if (!provider) return;
    Promise.resolve(provider()).then(next => {
      if(adHocAutoNextProvider !== provider) return; // 그 사이 다른 곡/모드로 바뀌었으면 무시
      if(next) startAdHocPlayback(next.url, next.name, next.artwork, provider);
      else { isAdHocPlaying = false; setPlayingState(false); }
    }).catch(e => { console.warn('내 음악 다음 곡(랜덤) 재생 실패:', e); isAdHocPlaying = false; setPlayingState(false); });
  }

  function nextTrack(auto){
    // "내 음악" 랜덤 재생 중이면 일반 재생목록으로 새지 않고 그 체인 안에서 계속 다음 곡을 고른다.
    if(isAdHocPlaying && adHocAutoNextProvider){ advanceMyMusicAutoNext(); return; }
    if(isAdHocPlaying){ isAdHocPlaying = false; adHocAutoNextProvider = null; } // 임시재생 중 '다음곡'을 누르면 정상 재생목록으로 복귀
    if(playlist.length === 0) return;
    if(isShuffle && playlist.length > 1){
      let r;
      do { r = Math.floor(Math.random()*playlist.length); } while(r === currentIndex);
      playTrack(r);
      return;
    }
    let ni = currentIndex + 1;
    if(ni >= playlist.length){
      if(repeatMode === 1) ni = 0;
      else { setPlayingState(false); return; }
    }
    playTrack(ni);
  }

  function prevTrack(){
    // "내 음악" 랜덤 재생은 히스토리가 없으므로, '이전 곡'은 지금 곡을 처음부터 다시 재생하는 걸로
    // 대신한다(재생목록의 기존 "3초 넘었으면 처음부터 다시" 동작과 같은 감각) - 절대 일반
    // 재생목록으로 새지 않는다.
    if(isAdHocPlaying && adHocAutoNextProvider){ audio.currentTime = 0; return; }
    if(isAdHocPlaying){ isAdHocPlaying = false; adHocAutoNextProvider = null; }
    if(playlist.length === 0) return;
    if(audio.currentTime > 3){
      audio.currentTime = 0;
      return;
    }
    let pi = currentIndex - 1;
    if(pi < 0) pi = repeatMode === 1 ? playlist.length - 1 : 0;
    playTrack(pi);
  }

  // ---- events ----
  fileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    fileInput.value = "";
  });

  ["dragenter","dragover"].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave","drop"].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  playBtn.addEventListener("click", togglePlay);
  nextBtn.addEventListener("click", () => nextTrack(false));
  prevBtn.addEventListener("click", prevTrack);

  shuffleBtn.addEventListener("click", () => {
    isShuffle = !isShuffle;
    shuffleBtn.classList.toggle("toggle-on", isShuffle);
  });
  repeatBtn.addEventListener("click", () => {
    repeatMode = (repeatMode + 1) % 3;
    repeatBtn.classList.toggle("toggle-on", repeatMode !== 0);
    repeatBtn.textContent = repeatMode === 2 ? "⟳¹" : "⟳";
    repeatBtn.title = repeatMode === 0 ? "반복 꺼짐" : repeatMode === 1 ? "전체 반복" : "한 곡 반복";
  });

  // "섞기"/"뒤집기"는 재생목록 자체의 순서를 바꾸는 것이다(재생 중 다음 곡을 무작위로 고르는
  // shuffleBtn의 재생 모드와는 다르다) - moveTrack()과 동일하게 현재 재생 중인 곡의 위치를 새 순서에서
  // 다시 찾아 currentIndex를 갱신하고, 화면을 다시 그린 뒤 바뀐 순서를 저장한다.
  shuffleOrderBtn.addEventListener("click", () => {
    if(playlist.length < 2) return;
    const currentTrackId = (currentIndex >= 0 && playlist[currentIndex]) ? playlist[currentIndex].id : null;
    for(let i = playlist.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
    }
    if(currentTrackId != null) currentIndex = playlist.findIndex(t => t.id === currentTrackId);
    renderList();
    persistOrder();
  });
  reverseOrderBtn.addEventListener("click", () => {
    if(playlist.length < 2) return;
    playlist.reverse();
    if(currentIndex >= 0) currentIndex = playlist.length - 1 - currentIndex;
    renderList();
    persistOrder();
  });

  clearAllBtn.addEventListener("click", async () => {
    if(playlist.length === 0) return;
    if(!confirm("이 플레이리스트의 곡을 모두 빼시겠어요?\n(저장된 음악 파일 자체는 삭제되지 않고 '내 음악'에 그대로 남아요)")) return;
    playlist.forEach(t => URL.revokeObjectURL(t.url));
    playlist = [];
    currentIndex = -1;
    audio.pause();
    audio.src = "";
    setPlayingState(false);
    updateNowPlaying();
    renderList();
    if(currentPlaylistId != null){
      try{ await dbClearTracksForPlaylist(currentPlaylistId); }catch(err){ console.warn("저장소 초기화 실패", err); }
    }
  });

  volumeEl.addEventListener("input", () => {
    audio.volume = parseFloat(volumeEl.value);
  });

  seek.addEventListener("input", () => {
    if(!audio.duration) return;
    audio.currentTime = (seek.value/100) * audio.duration;
  });

  audio.addEventListener("timeupdate", () => {
    if(audio.duration){
      seek.value = (audio.currentTime / audio.duration) * 100;
      curTimeEl.textContent = formatTime(audio.currentTime);
      if(ipodTimeCur) ipodTimeCur.textContent = formatTime(audio.currentTime);
      if(ipodProgressFill) ipodProgressFill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    }
  });
  audio.addEventListener("loadedmetadata", () => {
    durTimeEl.textContent = formatTime(audio.duration);
    if(ipodTimeDur) ipodTimeDur.textContent = formatTime(audio.duration);
  });
  audio.addEventListener("ended", () => {
    if(repeatMode === 2){
      audio.currentTime = 0;
      audio.play();
      return;
    }
    // "내 음악"에서 재생한 곡이 끝났을 때는(등록된 provider가 있으면) 그 provider가 골라주는
    // 다음 곡(랜덤)을 이어서 재생한다 - 기존 재생목록(playlist/currentIndex)과는 무관하다.
    if(isAdHocPlaying && adHocAutoNextProvider){ advanceMyMusicAutoNext(); return; }
    nextTrack(true);
  });
  audio.addEventListener("play", () => setPlayingState(true));
  audio.addEventListener("pause", () => {
    if(!audio.ended) setPlayingState(false);
  });

  // keyboard: space to toggle play when not typing in a field
  document.addEventListener("keydown", (e) => {
    const tabMixtape = document.getElementById('tab-mixtape');
    if(!tabMixtape || !tabMixtape.classList.contains('active')) return;
    if(e.code === "Space" && document.activeElement.tagName !== "INPUT"){
      e.preventDefault();
      togglePlay();
    }
  });

  renderList();
  initPlaylists();

  // ===== 홈 대시보드 연동용 (window.MixTapeApp) =====
  function getCurrentPlaylistName(){
    const p = playlists.find(pl => pl.id === currentPlaylistId);
    return p ? p.name : "";
  }
  function notifyMiniWidgetMixtape(){
    if (window.GlobalMiniController) window.GlobalMiniController.refresh();
  }
  window.MixTapeApp = {
    getNowPlaying: function(){
      if (isAdHocPlaying) {
        return {
          name: adHocName || '재생 중',
          artwork: adHocArtwork || null,
          playing: mixtapeRoot ? mixtapeRoot.classList.contains('playing') : false,
          currentTime: audio.currentTime || 0,
          duration: audio.duration || 0,
          index: -1,
          total: playlist.length,
          isShuffle: isShuffle,
          repeatMode: repeatMode,
          playlistName: getCurrentPlaylistName(),
          // "내 음악"에서 재생해서 다음 곡을 랜덤으로 이어가는 중인지 - PiP/인라인 위젯을 클릭했을 때
          // 어디로 이동시킬지(플레이리스트 목록이 아니라 내 음악 탭으로) 판단하는 데 쓰인다.
          isMyMusicAutoNext: !!adHocAutoNextProvider
        };
      }
      const hasTrack = currentIndex >= 0 && playlist[currentIndex];
      return {
        name: hasTrack ? playlist[currentIndex].name : null,
        artwork: hasTrack ? (playlist[currentIndex].artwork || null) : null,
        playing: mixtapeRoot ? mixtapeRoot.classList.contains('playing') : false,
        currentTime: audio.currentTime || 0,
        duration: audio.duration || 0,
        index: currentIndex,
        total: playlist.length,
        isShuffle: isShuffle,
        repeatMode: repeatMode,
        playlistName: getCurrentPlaylistName(),
        isMyMusicAutoNext: false
      };
    },
    togglePlay: togglePlay,
    nextTrack: () => nextTrack(false),
    prevTrack: prevTrack,
    toggleShuffle: function(){
      isShuffle = !isShuffle;
      shuffleBtn.classList.toggle("toggle-on", isShuffle);
      notifyMiniWidgetMixtape();
    },
    cycleRepeat: function(){
      repeatMode = (repeatMode + 1) % 3;
      repeatBtn.classList.toggle("toggle-on", repeatMode !== 0);
      repeatBtn.textContent = repeatMode === 2 ? "⟳¹" : "⟳";
      repeatBtn.title = repeatMode === 0 ? "반복 꺼짐" : repeatMode === 1 ? "전체 반복" : "한 곡 반복";
      notifyMiniWidgetMixtape();
    },
    // 1-2 Music: 기존 playlist/currentIndex를 건드리지 않고, 같은 audio 엘리먼트로 곡을 하나 바로 재생한다.
    // (SoundCloud처럼 "클릭하면 바로 재생"을 위한 최소 확장 - 기존 재생 목록 탐색과는 독립적으로 동작한다)
    playAdHoc: function(url, name, artwork){ startAdHocPlayback(url, name, artwork, null); },
    // "내 음악"에서 곡이 끝났을 때 다음 곡을 골라줄 provider(예: 랜덤으로 다른 곡 하나 반환)를 함께
    // 등록한다 - provider는 { url, name, artwork } 또는 null(더 재생할 곡이 없음)을 반환해야 한다.
    playAdHocWithAutoNext: function(url, name, artwork, nextProviderFn){ startAdHocPlayback(url, name, artwork, nextProviderFn || null); },
    // 1-2 Music: 플레이리스트 "이름 목록" 화면에서 특정 플레이리스트를 열 때 쓴다.
    // 기존 함수를 그대로 재사용 - 이미 같은 플레이리스트가 열려있으면 다시 로드하지 않는 기존 보호
    // 로직도 그대로 적용된다 (재생 중인 곡이 처음부터 다시 시작되지 않음).
    switchToPlaylist: function(id){ return switchPlaylist(id); },
    // "내 음악"에서 이 플레이리스트로 곡을 추가했을 때, 재생을 끊지 않고 목록만 다시 그린다.
    refreshIfCurrent: function(id){ if (id === currentPlaylistId) return refreshCurrentPlaylistTracks(); },
    getCurrentPlaylistId: function(){ return currentPlaylistId; },
    // 1-2 Music: "보기 전용" 화면(#playlist-browse-wrapper)에서 곡을 눌렀을 때만 쓴다. 그제서야
    // 실제로 이 플레이리스트로 재생을 전환하고, 누른 곡부터 바로 재생을 시작한다.
    playTrackInPlaylist: async function(id, index){ await switchPlaylist(id); playTrack(index); },
    // 아래 세 개는 전부 "보기 전용" 화면 전용이다 - 재생 엔진의 playlist/currentIndex(=지금
    // 재생 중인 다른 플레이리스트)는 전혀 건드리지 않고, 지정한 플레이리스트id의 트랙만 IndexedDB에서
    // 직접 읽고 쓴다. moveTrack/removeTrack/persistOrder는 currentPlaylistId를 암묵적으로 쓰기 때문에
    // 재생 중이 아닌 다른 플레이리스트에는 그대로 재사용할 수 없어서 별도로 만들었다.
    getTracksForPlaylist: function(id){ return dbGetTracksByPlaylist(id); },
    reorderPlaylistTracks: function(id, orderedTrackIds){ return dbUpdateTrackOrderForPlaylist(id, orderedTrackIds); },
    removeTrackFromPlaylist: function(id, trackId){ return dbRemoveTrackRefFromPlaylist(id, trackId); },
    // 지금 열려 있는(재생 화면의) 플레이리스트의 트랙 사이 "+" 버튼 전용 - "내 음악" 트랙 레코드들을
    // 지정된 위치에 참조로 끼워 넣는다.
    insertLibraryTracksAtIndex: function(tracks, insertIndex){ return insertLibraryTracksAtIndex(tracks, insertIndex); },
    // 데이터 가져오기(백업 파일 복원) 전용: 프롬프트 없이 이름을 지정해서 바로 플레이리스트를 만든다.
    createPlaylistNamed: function(name){ return dbAddPlaylist(name || '가져온 플레이리스트'); },
    // 1-2 Music: 선택 모드 제어 - 별도 화면을 새로 만들지 않고 기존 트랙리스트에 체크박스만 켠다.
    enterSelectMode: function(){
      selectModeActive = true;
      selectedTrackIndices = new Set();
      renderList();
    },
    exitSelectMode: function(){
      selectModeActive = false;
      selectedTrackIndices = new Set();
      renderList();
    },
    isSelectModeActive: function(){ return selectModeActive; },
    getSelectedCount: function(){ return selectedTrackIndices.size; },
    getTrackCount: function(){ return playlist.length; },
    selectAllTracks: function(){
      selectedTrackIndices = new Set(playlist.map((_, i) => i));
      renderList();
    },
    deselectAllTracks: function(){
      selectedTrackIndices = new Set();
      renderList();
    },
    deleteSelectedTracks: function(){
      const count = selectedTrackIndices.size;
      if(count === 0) return 0;
      removeSelectedTracks(selectedTrackIndices);
      selectedTrackIndices = new Set();
      return count;
    },
    // 1-2 Music: Music Home의 "재생 중" 위젯 탐색바(seek)용. 기존 audio 객체의 currentTime만 옮긴다.
    seekTo: function(seconds){
      try {
        if (isFinite(seconds) && seconds >= 0) audio.currentTime = seconds;
      } catch (e) { console.warn('탐색 실패:', e); }
    }
  };

  // 재생 상태가 바뀌는 모든 지점에서 전역 미니 위젯에도 알림
  audio.addEventListener("timeupdate", notifyMiniWidgetMixtape);
  audio.addEventListener("loadedmetadata", notifyMiniWidgetMixtape);
  audio.addEventListener("play", notifyMiniWidgetMixtape);
  audio.addEventListener("pause", notifyMiniWidgetMixtape);
  audio.addEventListener("ended", notifyMiniWidgetMixtape);
  const _origPlayTrack = playTrack;
  playTrack = function(i){ _origPlayTrack(i); notifyMiniWidgetMixtape(); };
})();


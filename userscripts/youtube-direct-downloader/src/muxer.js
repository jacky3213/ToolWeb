// src/muxer.js
//
// 無損音視頻合併（不重新編碼），基於 mediabunny 1.61.6 的真實 API。
//
// 與任務參考碼的差異（以 mediabunny 1.61.6 實際 API 為準）：
//   1. 不存在 BlobTarget。改用 BufferTarget，完成後經 `buffer` property 取得 ArrayBuffer。
//   2. Input 建構簽名為 `new Input({ formats, source })`，而非 `new Input(source)`；
//      且無 `.videoTracks[0]` / `.audioTracks[0]`，須用 getVideoTracks()/getAudioTracks()。
//   3. Output 建構簽名為 `new Output({ format, target })`，而非 `new Output(format, target)`；
//      addVideoTrack/addAudioTrack 接收「source 物件」而非 codec 字串。
//   4. EncodedVideo/AudioPacketSource 建構需傳 codec（取自 input track.getCodec()），
//      並在首個封包時以 meta.decoderConfig 提供解碼設定（取自 track.getDecoderConfig()）。
import {
  Input,
  Output,
  BlobSource,
  StreamTarget,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  MP4,
  WEBM,
  MATROSKA,
} from 'mediabunny';

// 輸入容器格式白名單：涵蓋 YouTube 的 progressive/adaptive MP4 與 WebM/Matroska。
const INPUT_FORMATS = [MP4, WEBM, MATROSKA];

function makeFormat(container) {
  return container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat();
}

// 從單一 input 取主軌並建立對應的「編碼封包 source」，註冊到 output。
// 回傳 { track, source } 供後續拷貝封包使用。
async function registerTrack(input, kind, output) {
  const tracks = kind === 'video'
    ? await input.getVideoTracks()
    : await input.getAudioTracks();
  const track = tracks[0] ?? null;
  if (!track) throw new Error(`輸入中找不到 ${kind} 軌`);

  const codec = await track.getCodec();
  if (!codec) throw new Error(`無法判斷 ${kind} 軌的 codec`);

  const source = kind === 'video'
    ? new EncodedVideoPacketSource(codec)
    : new EncodedAudioPacketSource(codec);

  if (kind === 'video') output.addVideoTrack(source);
  else output.addAudioTrack(source);

  return { track, source };
}

// 將某軌的所有編碼封包從 input 拷貝到 output 的 source（無損，維持 decode order）。
async function copyTrack({ track, source }) {
  const sink = new EncodedPacketSink(track);
  const decoderConfig = await track.getDecoderConfig();
  let isFirst = true;

  for await (const packet of sink.packets()) {
    // 僅首個封包攜帶 decoderConfig（含 codec 初始化資料）；其餘省略以減少負擔。
    const meta = isFirst && decoderConfig ? { decoderConfig } : undefined;
    isFirst = false;
    await source.add(packet, meta);
  }
}

// 核心合併邏輯：videoInput / audioInput 皆為已建好的 Input 實例（或 null）。
async function muxInternal({ videoInput, audioInput, container, target }) {
  if (!videoInput && !audioInput) {
    throw new Error('mux：至少需要一個 video 或 audio 輸入');
  }

  const output = new Output({ format: makeFormat(container), target });

  const jobs = [];
  if (videoInput) jobs.push(await registerTrack(videoInput, 'video', output));
  if (audioInput) jobs.push(await registerTrack(audioInput, 'audio', output));

  // 所有軌註冊完畢後才能 start；start 之後才能 add 封包。
  try {
    await output.start();

    // 各軌獨立拷貝，由 muxer 依時間戳交錯寫入；await 以尊重背壓。
    await Promise.all(jobs.map((job) => copyTrack(job)));

    await output.finalize();
  } catch (err) {
    // mux 失敗/取消：對尚未 finalize 的 target 呼叫 cancel() 釋放資源
    // （例如 File System Access 的 writable，避免留下半成品檔案）
    try { await output.cancel(); } catch { /* 已釋放或無 cancel */ }
    throw err;
  } finally {
    if (videoInput) videoInput.dispose();
    if (audioInput) audioInput.dispose();
  }
}

// 兩個 Blob（已解密的 media 資料）→ 合併寫入 target（StreamTarget 或 BufferTarget）。
export async function muxBlobs({ videoBlob, audioBlob, container, target }) {
  const videoInput = videoBlob ? new Input({ formats: INPUT_FORMATS, source: new BlobSource(videoBlob) }) : null;
  const audioInput = audioBlob ? new Input({ formats: INPUT_FORMATS, source: new BlobSource(audioBlob) }) : null;
  await muxInternal({ videoInput, audioInput, container, target });
}

// SABR / 串流路徑：直接吃 ReadableStreamSource（或 UrlSource）物件，
// 邏輯與 muxBlobs 相同，只是 Input 的 source 直接是傳入的 source。
export async function muxSources({ videoSource, audioSource, container, target }) {
  const videoInput = videoSource ? new Input({ formats: INPUT_FORMATS, source: videoSource }) : null;
  const audioInput = audioSource ? new Input({ formats: INPUT_FORMATS, source: audioSource }) : null;
  await muxInternal({ videoInput, audioInput, container, target });
}

// 包裝 File System Access API 的 writable 為 StreamTarget。
export function streamTargetFor(writable) {
  return new StreamTarget(writable);
}

// 記憶體內合併用 target。mediabunny 1.61.6 無 BlobTarget，
// 以 BufferTarget 取代；完成後經 `.buffer` (ArrayBuffer|null) 取得結果，再轉 Blob。
export function blobTarget() {
  return new BufferTarget();
}

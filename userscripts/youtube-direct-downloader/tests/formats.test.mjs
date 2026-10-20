import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGoogleVideoUrl, stripRangeParams, containerOf,
  pairVideoAudio, buildQualityList, pickAudioTrack,
} from '../src/formats.js';

test('isGoogleVideoUrl 接受合法網域並拒絕其他', () => {
  assert.equal(isGoogleVideoUrl('https://rr4---sn-xyz.googlevideo.com/videoplayback?x=1'), true);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com/videoplayback'), true);
  assert.equal(isGoogleVideoUrl('https://evil.com/googlevideo.com'), false);
  assert.equal(isGoogleVideoUrl('https://googlevideo.com.evil.com/videoplayback'), false);
  assert.equal(isGoogleVideoUrl('not a url'), false);
});

test('stripRangeParams 移除 range/rn/rbuf 但保留其他參數', () => {
  const out = stripRangeParams('https://v.googlevideo.com/videoplayback?range=0-999&rn=1&rbuf=0&itag=140&mime=audio%2Fmp4');
  assert.ok(!out.includes('range='));
  assert.ok(!out.includes('rn='));
  assert.ok(!out.includes('rbuf='));
  assert.ok(out.includes('itag=140'));
});

test('containerOf 解析 mime type 容器', () => {
  assert.equal(containerOf('video/mp4; codecs="avc1.640028"'), 'mp4');
  assert.equal(containerOf('audio/webm; codecs="opus"'), 'webm');
});

test('pairVideoAudio 同容器優先、音軌取最高位元率', () => {
  const videos = [
    { itag: 137, has_video: true, has_audio: false, mime_type: 'video/mp4', quality_label: '1080p', bitrate: 2000 },
    { itag: 248, has_video: true, has_audio: false, mime_type: 'video/webm', quality_label: '1080p', bitrate: 1800 },
  ];
  const audios = [
    { itag: 251, has_audio: true, has_video: false, mime_type: 'audio/webm', bitrate: 160 },
    { itag: 140, has_audio: true, has_video: false, mime_type: 'audio/mp4', bitrate: 128 },
    { itag: 139, has_audio: true, has_video: false, mime_type: 'audio/mp4', bitrate: 48 },
  ];
  assert.deepEqual(pairVideoAudio(videos, audios), [
    { video: videos[0], audio: audios[1] },
    { video: videos[1], audio: audios[0] },
  ]);
});

test('buildQualityList 依解析度/fps 降序、含漸進式與分離式、估算大小', () => {
  const formats = [
    { itag: 137, has_video: true, has_audio: false, mime_type: 'video/mp4', quality_label: '1080p', fps: 30, height: 1080, content_length: 900 },
    { itag: 140, has_audio: true, has_video: false, mime_type: 'audio/mp4', bitrate: 128, content_length: 100 },
    { itag: 22,  has_video: true, has_audio: true,  mime_type: 'video/mp4', quality_label: '720p', fps: 30, height: 720, content_length: 800 },
    { itag: 299, has_video: true, has_audio: false, mime_type: 'video/mp4', quality_label: '1080p', fps: 60, height: 1080, content_length: 1200 },
  ];
  const list = buildQualityList(formats, { audioLanguage: null });
  assert.equal(list.length, 3);
  assert.equal(list[0].label, '1080p60');
  assert.equal(list[0].isProgressive, false);
  assert.equal(list[0].sizeBytes, 1300);
  assert.equal(list[2].isProgressive, true);
  assert.equal(list[2].sizeBytes, 800);
});

test('pickAudioTrack 語言優先：指定語言 > 原聲 > 任一', () => {
  const tracks = [
    { itag: 140, mime_type: 'audio/mp4', language: 'ja', is_original: false, bitrate: 128 },
    { itag: 141, mime_type: 'audio/mp4', language: 'en', is_original: true,  bitrate: 256 },
  ];
  assert.equal(pickAudioTrack(tracks, 'ja').itag, 140);
  assert.equal(pickAudioTrack(tracks, 'zh-TW').itag, 141);
  assert.equal(pickAudioTrack(tracks, null).itag, 141);
});

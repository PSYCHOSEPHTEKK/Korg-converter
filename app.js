const fileInput = document.querySelector('#file');
const dropzone = document.querySelector('#dropzone');
const convertButton = document.querySelector('#convert');
const status = document.querySelector('#status');
let selectedFile = null;

function setFile(file) {
  if (!file) return;
  if (!file.type.startsWith('audio/') && !file.type.startsWith('video/') && !/\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm|m4v|mkv)$/i.test(file.name)) {
    status.textContent = 'Bitte eine unterstützte Audio- oder Videodatei auswählen.';
    return;
  }
  selectedFile = file;
  status.textContent = `Ausgewählt: ${file.name}. Gib Startzeit und Ausschnittlänge ein (höchstens 10 Sekunden).`;
  convertButton.disabled = false;
}

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

dropzone.addEventListener('dragover', event => {
  event.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('drag');
  setFile(event.dataTransfer.files[0]);
});

function resampleChannel(source, sourceRate, outputRate) {
  const outputLength = Math.floor(source.length * outputRate / sourceRate);
  const result = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const position = i * sourceRate / outputRate;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = source[index] || 0;
    const b = source[index + 1] ?? a;
    result[i] = a + (b - a) * fraction;
  }
  return result;
}

function encodePcm16(channels, sampleRate) {
  const frameCount = channels[0].length;
  const channelCount = channels.length;
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + frameCount * channelCount * bytesPerSample);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + frameCount * channelCount * bytesPerSample, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, frameCount * channelCount * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function isVideo(file) {
  return file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name);
}

async function getVideoAudio(file, startSeconds, durationSeconds) {
  const context = new AudioContext();
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = false;
  video.style.display = 'none';
  document.body.append(video);

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Das Video konnte nicht geöffnet werden.'));
    });
    if (!Number.isFinite(video.duration)) throw new Error('Die Videolänge konnte nicht ermittelt werden.');
    if (startSeconds >= video.duration) throw new Error('Die Startzeit liegt hinter dem Ende des Videos.');

    const actualDuration = Math.min(durationSeconds, video.duration - startSeconds);
    const source = context.createMediaElementSource(video);
    const processor = context.createScriptProcessor(4096, 2, 2);
    const leftParts = [];
    const rightParts = [];
    const endSeconds = startSeconds + actualDuration;
    let finished = false;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });

    processor.onaudioprocess = event => {
      const time = video.currentTime;
      if (time >= startSeconds && time < endSeconds) {
        const input = event.inputBuffer;
        const left = input.getChannelData(0).slice();
        const right = input.numberOfChannels > 1 ? input.getChannelData(1).slice() : left.slice();
        leftParts.push(left);
        rightParts.push(right);
      }
      for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel++) {
        event.outputBuffer.getChannelData(channel).fill(0);
      }
      if (!finished && (time >= endSeconds || video.ended)) {
        finished = true;
        video.pause();
        finish();
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
    video.currentTime = startSeconds;
    await new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - startSeconds) < 0.01) resolve();
      else {
        video.onseeked = resolve;
        video.onerror = () => reject(new Error('Das Video konnte nicht an die gewählte Stelle springen.'));
      }
    });
    await context.resume();
    await video.play();
    await done;

    const join = parts => {
      const length = parts.reduce((sum, part) => sum + part.length, 0);
      const result = new Float32Array(length);
      let offset = 0;
      for (const part of parts) { result.set(part, offset); offset += part.length; }
      return result;
    };
    const left = join(leftParts);
    const right = join(rightParts);
    if (!left.length) throw new Error('Im gewählten Videoausschnitt wurde kein Audiosignal gefunden.');
    return { left, right, sampleRate: context.sampleRate };
  } finally {
    await context.close();
    video.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

convertButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  const startSeconds = Math.max(0, Number(document.querySelector('#start').value) || 0);
  const durationSeconds = Number(document.querySelector('#seconds').value);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 10) {
    status.textContent = 'Die Ausschnittlänge muss größer als 0 und darf höchstens 10 Sekunden sein.';
    return;
  }

  convertButton.disabled = true;
  status.textContent = isVideo(selectedFile) ? 'Video-Audio wird ausgelesen…' : 'Audiodatei wird dekodiert…';
  let context;

  try {
    let left;
    let right;
    let sourceRate;
    if (isVideo(selectedFile)) {
      ({ left, right, sampleRate: sourceRate } = await getVideoAudio(selectedFile, startSeconds, durationSeconds));
    } else {
      context = new AudioContext();
      const decoded = await context.decodeAudioData(await selectedFile.arrayBuffer());
      const startFrame = Math.min(decoded.length, Math.floor(startSeconds * decoded.sampleRate));
      const requestedFrames = Math.floor(durationSeconds * decoded.sampleRate);
      const frameCount = Math.min(requestedFrames, decoded.length - startFrame);
      if (frameCount <= 0) throw new Error('Die Startzeit liegt hinter dem Ende der Audiodatei.');
      left = decoded.getChannelData(0).slice(startFrame, startFrame + frameCount);
      right = decoded.numberOfChannels > 1
        ? decoded.getChannelData(1).slice(startFrame, startFrame + frameCount)
        : left.slice();
      sourceRate = decoded.sampleRate;
      await context.close();
      context = null;
    }

    const outputRate = Number(document.querySelector('#rate').value);
    const outputChannels = Number(document.querySelector('#channels').value);
    let leftResampled = resampleChannel(left, sourceRate, outputRate);
    let rightResampled = resampleChannel(right, sourceRate, outputRate);
    const maxOutputFrames = Math.ceil(durationSeconds * outputRate);
    leftResampled = leftResampled.slice(0, maxOutputFrames);
    rightResampled = rightResampled.slice(0, maxOutputFrames);

    if (document.querySelector('#normalize').checked) {
      let peak = 0;
      for (let i = 0; i < leftResampled.length; i++) {
        peak = Math.max(peak, Math.abs(leftResampled[i]), Math.abs(rightResampled[i]));
      }
      if (peak > 0.95) {
        const scale = 0.95 / peak;
        for (let i = 0; i < leftResampled.length; i++) {
          leftResampled[i] *= scale;
          rightResampled[i] *= scale;
        }
      }
    }

    let channels;
    if (outputChannels === 1) {
      const mono = new Float32Array(leftResampled.length);
      for (let i = 0; i < mono.length; i++) mono[i] = (leftResampled[i] + rightResampled[i]) * 0.5;
      channels = [mono];
    } else {
      channels = [leftResampled, rightResampled];
    }

    const wav = encodePcm16(channels, outputRate);
    const downloadUrl = URL.createObjectURL(wav);
    const link = document.createElement('a');
    const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
    link.href = downloadUrl;
    link.download = `${baseName}-start-${startSeconds}s-${durationSeconds}s.wav`;
    link.textContent = 'WAV herunterladen';
    link.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000), { once: true });
    status.replaceChildren(document.createTextNode(`Fertig: ${Math.round(wav.size / 1024)} KB — `), link);
  } catch (error) {
    console.error(error);
    status.textContent = `Fehler: ${error.message || 'Die Datei konnte nicht verarbeitet werden.'}`;
  } finally {
    if (context) await context.close().catch(() => {});
    convertButton.disabled = false;
  }
});

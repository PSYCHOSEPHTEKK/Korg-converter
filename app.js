const fileInput = document.querySelector('#file');
const dropzone = document.querySelector('#dropzone');
const convertButton = document.querySelector('#convert');
const status = document.querySelector('#status');
let selectedFile = null;

function setFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.mp3') && file.type !== 'audio/mpeg') {
    status.textContent = 'Bitte eine MP3-Datei auswählen.';
    return;
  }
  selectedFile = file;
  status.textContent = `Ausgewählt: ${file.name}`;
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

function resampleChannel(source, sourceRate, outputRate, startFrame, frameCount) {
  const outputLength = Math.round(frameCount * outputRate / sourceRate);
  const result = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const position = startFrame + i * sourceRate / outputRate;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = source[index] || 0;
    const b = source[index + 1] || a;
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

  function writeText(offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

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

convertButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  convertButton.disabled = true;
  status.textContent = 'MP3 wird dekodiert…';

  try {
    const audioContext = new AudioContext();
    const sourceBuffer = await selectedFile.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(sourceBuffer);

    const outputRate = Number(document.querySelector('#rate').value);
    const outputChannels = Number(document.querySelector('#channels').value);
    const maxSeconds = Math.max(1, Number(document.querySelector('#seconds').value) || 30);

    const availableFrames = decoded.length;
    const frameCount = Math.min(availableFrames, Math.round(maxSeconds * decoded.sampleRate));

    let left = decoded.getChannelData(0);
    let right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;

    let leftResampled = resampleChannel(left, decoded.sampleRate, outputRate, 0, frameCount);
    let rightResampled = resampleChannel(right, decoded.sampleRate, outputRate, 0, frameCount);

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
    const url = URL.createObjectURL(wav);
    const link = document.createElement('a');
    const baseName = selectedFile.name.replace(/\.mp3$/i, '');
    link.href = url;
    link.download = `${baseName}-korg.wav`;
    link.textContent = 'WAV herunterladen';

    status.replaceChildren(document.createTextNode(
      `Fertig: ${Math.round(wav.size / 1024)} KB — `
    ), link);
    await audioContext.close();
  } catch (error) {
    console.error(error);
    status.textContent = `Fehler: ${error.message || 'MP3 konnte nicht verarbeitet werden.'}`;
  } finally {
    convertButton.disabled = false;
  }
});

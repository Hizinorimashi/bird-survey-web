/**
 * 鳴き声AI 判別ワーカー（本体用・v229）
 * 試作 prototype/birdnet-worker.js（Codex監査済み）を元に、本体向けに次を変えたもの:
 *  - tf.min.js は importScripts せず、本体が保存領域から読んだ中身をこのファイルの前に連結して起動する（Blob）
 *  - AI本体（model.json・重み）は**保存領域（Cache Storage）からだけ**読む。無ければ失敗にする（勝手に通信しない）
 *  - 3秒区間ごとの判定結果（種ごとの確からしさ）だけを返す
 * 元: BirdNET Live (https://github.com/birdnet-team/real-time-pwa, MIT License, Copyright (c) 2025 BirdNET-Team)
 *     の birdnet-worker.js。元コードは https://github.com/georg95/birdnet-web に基づく。
 * モデル: BirdNET (Cornell Lab of Ornithology / Chemnitz University of Technology), CC BY-SA 4.0
 */
'use strict';
const WINDOW_SAMPLES = 144000; // 3秒（48kHz）
const BATCH_FRAMES = 4;        // 一度にAIへ渡す3秒区間の数（メモリ節約）
let birdModel = null;
let CACHE_NAME = '';

// 保存領域からだけ読む fetch（tf の読み込みに渡す）。無いものは通信せず失敗にする
async function cachedFetch(input) {
  const url = typeof input === 'string' ? input : input.url;
  const c = await caches.open(CACHE_NAME);
  const r = await c.match(url);
  if (!r) throw new Error('AIのファイルが端末に保存されていません: ' + url.split('/').pop());
  return r;
}


// ---- 以下2つは公式コードそのまま（音声→スペクトログラム変換） ----
class MelSpecLayerSimple extends tf.layers.Layer {
  constructor(config) {
    super(config);
    this.sampleRate = config.sampleRate;
    this.specShape = config.specShape;
    this.frameStep = config.frameStep;
    this.frameLength = config.frameLength;
    this.melFilterbank = tf.tensor2d(config.melFilterbank);
  }
  build() {
    this.magScale = this.addWeight(
      'magnitude_scaling', [], 'float32',
      tf.initializers.constant({ value: 1.23 })
    );
    super.build();
  }
  computeOutputShape(inputShape) {
    return [inputShape[0], this.specShape[0], this.specShape[1], 1];
  }
  call(inputs) {
    return tf.tidy(() => {
      const x = inputs[0];
      return tf.stack(x.split(x.shape[0]).map(input => {
        let spec = input.squeeze();
        spec = tf.sub(spec, tf.min(spec, -1, true));
        spec = tf.div(spec, tf.max(spec, -1, true).add(1e-6));
        spec = tf.sub(spec, 0.5).mul(2.0);
        spec = tf.engine().runKernel('STFT', {
          signal: spec, frameLength: this.frameLength, frameStep: this.frameStep
        });
        spec = tf.matMul(spec, this.melFilterbank).pow(2.0);
        spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))));
        spec = tf.reverse(spec, -1);
        spec = tf.transpose(spec).expandDims(-1);
        return spec;
      }));
    });
  }
  static get className() { return 'MelSpecLayerSimple'; }
}

tf.registerKernel({
  kernelName: 'STFT',
  backendName: 'webgl',
  kernelFunc: ({ backend, inputs: { signal, frameLength, frameStep } }) => {
    const innerDim = frameLength / 2;
    const batch = (signal.size - frameLength + frameStep) / frameStep | 0;
    let currentTensor = backend.runWebGLProgram({
      variableNames: ['x'],
      outputShape: [batch, frameLength],
      userCode: `void main(){
        ivec2 c=getOutputCoords();
        int p=c[1]%${innerDim};
        int k=0;
        for(int i=0;i<${Math.log2(innerDim)};++i){
          if((p & (1<<i))!=0){ k|=(1<<(${Math.log2(innerDim) - 1}-i)); }
        }
        int i=2*k;
        if(c[1]>=${innerDim}){ i=2*(k%${innerDim})+1; }
        int q=c[0]*${frameLength}+i;
        float val=getX((q/${frameLength})*${frameStep}+ q % ${frameLength});
        float cosArg=${2.0 * Math.PI / frameLength}*float(q);
        float mul=0.5-0.5*cos(cosArg);
        setOutput(val*mul);
      }`
    }, [signal], 'float32');
    for (let len = 1; len < innerDim; len *= 2) {
      let prevTensor = currentTensor;
      currentTensor = backend.runWebGLProgram({
        variableNames: ['x'],
        outputShape: [batch, innerDim * 2],
        userCode: `void main(){
          ivec2 c=getOutputCoords();
          int b=c[0];
          int i=c[1];
          int k=i%${innerDim};
          int isHigh=(k%${len * 2})/${len};
          int highSign=(1 - isHigh*2);
          int baseIndex=k - isHigh*${len};
          float t=${Math.PI / len}*float(k%${len});
          float a=cos(t);
          float bsin=sin(-t);
          float oddK_re=getX(b, baseIndex+${len});
          float oddK_im=getX(b, baseIndex+${len + innerDim});
          if(i<${innerDim}){
            float evenK_re=getX(b, baseIndex);
            setOutput(evenK_re + (oddK_re*a - oddK_im*bsin)*float(highSign));
          } else {
            float evenK_im=getX(b, baseIndex+${innerDim});
            setOutput(evenK_im + (oddK_re*bsin + oddK_im*a)*float(highSign));
          }
        }`
      }, [prevTensor], 'float32');
      backend.disposeIntermediateTensorInfo(prevTensor);
    }
    const real = backend.runWebGLProgram({
      variableNames: ['x'],
      outputShape: [batch, innerDim + 1],
      userCode: `void main(){
        ivec2 c=getOutputCoords();
        int b=c[0];
        int i=c[1];
        int zI=i%${innerDim};
        int conjI=(${innerDim}-i)%${innerDim};
        float Zk0=getX(b,zI);
        float Zk1=getX(b,zI+${innerDim});
        float Zk_conj0=getX(b,conjI);
        float Zk_conj1=-getX(b,conjI+${innerDim});
        float t=${-2.0 * Math.PI}*float(i)/float(${innerDim * 2});
        float diff0=Zk0 - Zk_conj0;
        float diff1=Zk1 - Zk_conj1;
        float result=(Zk0+Zk_conj0 + cos(t)*diff1 + sin(t)*diff0)*0.5;
        setOutput(result);
      }`
    }, [currentTensor], 'float32');
    backend.disposeIntermediateTensorInfo(currentTensor);
    return real;
  }
});
// ---- 公式コードここまで ----


async function init(modelUrl) {
  await tf.setBackend('webgl');
  tf.serialization.registerClass(MelSpecLayerSimple);
  birdModel = await tf.loadLayersModel(modelUrl, {
    fetchFunc: cachedFetch,
    onProgress: p => postMessage({ message: 'progress', progress: Math.round(p * 100) })
  });
  tf.tidy(() => { birdModel.predict(tf.zeros([1, WINDOW_SAMPLES])); });   // 最初の1回は遅いので先に済ませる
}

// 重ならない3秒区間 n 個（pcm の長さ = n × 3秒）の判定結果を、区間ごとに並べて返す
async function handleScores({ id, pcm }) {
  const n = Math.floor(pcm.length / WINDOW_SAMPLES);
  let out = null, C = 0;
  for (let f0 = 0; f0 < n; f0 += BATCH_FRAMES) {
    const k = Math.min(BATCH_FRAMES, n - f0);
    const x = tf.tensor2d(pcm.subarray(f0 * WINDOW_SAMPLES, (f0 + k) * WINDOW_SAMPLES), [k, WINDOW_SAMPLES]);
    const y = birdModel.predict(x);
    const arr = await y.data();
    x.dispose(); y.dispose();
    if (!out) { C = arr.length / k; out = new Float32Array(n * C); }
    out.set(arr, f0 * C);
  }
  postMessage({ message: 'scores', id, scores: out, C, n }, out ? [out.buffer] : []);
}

onmessage = async ({ data }) => {
  try {
    if (data.message === 'init') {
      CACHE_NAME = String(data.cacheName || '');
      await init(data.modelUrl);
      postMessage({ message: 'loaded', id: data.id, backend: tf.getBackend() });
    } else if (data.message === 'scores') {
      await handleScores(data);
    }
  } catch (e) {
    postMessage({ message: 'error', id: data.id, text: String(e && e.message || e) });
  }
};

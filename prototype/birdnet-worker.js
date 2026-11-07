/**
 * BirdNET 判別ワーカー（試作）
 * BirdNET Live (https://github.com/birdnet-team/real-time-pwa, MIT License, Copyright (c) 2025 BirdNET-Team)
 * の birdnet-worker.js を元に、結果を数値配列で返す形に簡略化したもの。
 * 元コードは https://github.com/georg95/birdnet-web に基づく。
 * モデル: BirdNET (Cornell Lab of Ornithology / Chemnitz University of Technology), CC BY-SA 4.0
 */

importScripts('tf.min.js');

const MODEL_PATH = 'models/birdnet/model.json';
const AREA_MODEL_PATH = 'models/birdnet/area-model/model.json';
const SAMPLE_RATE = 48000;
const WINDOW_SAMPLES = 144000; // 3秒
const BATCH_FRAMES = 8;        // 一度にAIへ渡す3秒区間の数（メモリ節約）
const POOL_ALPHA = 5.0;        // 区間をまとめる時の重み（公式と同じ）

let birdModel = null;
let areaModel = null;

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

init();

async function init() {
  try {
    await tf.setBackend('webgl');
    tf.serialization.registerClass(MelSpecLayerSimple);
    birdModel = await tf.loadLayersModel(MODEL_PATH, {
      onProgress: p => postMessage({ message: 'progress', progress: Math.round(p * 90) })
    });
    tf.tidy(() => { birdModel.predict(tf.zeros([1, WINDOW_SAMPLES])); });
    try {
      areaModel = await tf.loadGraphModel(AREA_MODEL_PATH);
    } catch (e) {
      postMessage({ message: 'warn', text: '場所のAIを読み込めませんでした: ' + e });
    }
    postMessage({ message: 'loaded', backend: tf.getBackend() });
  } catch (e) {
    postMessage({ message: 'error', text: String(e && e.stack || e) });
  }
}

onmessage = async ({ data }) => {
  try {
    if (data.message === 'predict') await handlePredict(data);
    else if (data.message === 'area') await handleArea(data);
  } catch (e) {
    postMessage({ message: 'error', id: data.id, text: String(e && e.stack || e) });
  }
};

// 音声を3秒窓（1.5秒ずつずらす）に区切って判定し、
// 種ごとに「まとめ値（log-mean-exp）」と「最大値」を返す
async function handlePredict({ id, pcm, hopSec = 1.5 }) {
  const hop = Math.round(hopSec * SAMPLE_RATE);
  const total = pcm.length;
  const nFrames = Math.max(1, Math.ceil(Math.max(0, total - WINDOW_SAMPLES) / hop) + 1);
  let sumExp = null, maxv = null;
  for (let f0 = 0; f0 < nFrames; f0 += BATCH_FRAMES) {
    const n = Math.min(BATCH_FRAMES, nFrames - f0);
    const framed = new Float32Array(n * WINDOW_SAMPLES);
    for (let j = 0; j < n; j++) {
      const start = (f0 + j) * hop;
      framed.set(pcm.subarray(start, Math.min(start + WINDOW_SAMPLES, total)), j * WINDOW_SAMPLES);
    }
    const x = tf.tensor2d(framed, [n, WINDOW_SAMPLES]);
    const y = birdModel.predict(x);
    const arr = await y.data();
    x.dispose(); y.dispose();
    const nc = arr.length / n;
    if (!sumExp) { sumExp = new Float64Array(nc); maxv = new Float32Array(nc); }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < nc; i++) {
        const v = arr[j * nc + i];
        sumExp[i] += Math.exp(POOL_ALPHA * v);
        if (v > maxv[i]) maxv[i] = v;
      }
    }
    postMessage({ message: 'predict_progress', id, done: Math.min(f0 + n, nFrames), total: nFrames });
  }
  const pooled = new Float32Array(sumExp.length);
  for (let i = 0; i < sumExp.length; i++) pooled[i] = Math.log(sumExp[i] / nFrames) / POOL_ALPHA;
  postMessage({ message: 'predicted', id, pooled, maxv, nFrames }, [pooled.buffer, maxv.buffer]);
}

// 緯度・経度・週（1〜48）から、その場所・時期にいそうな度合いを返す
async function handleArea({ id, lat, lng, week }) {
  if (!areaModel) { postMessage({ message: 'area', id, scores: null }); return; }
  const input = tf.tensor([[lat, lng, week]]);
  const out = areaModel.predict(input);
  const scores = await out.data();
  input.dispose(); out.dispose();
  postMessage({ message: 'area', id, scores });
}

/* ================================================================
 * liquidGlass.js — 液态玻璃导航栏渲染引擎
 *
 * 完整移植自根目录 liquid-glass-webgl-2.0.0 项目（源自 Compose
 * LiquidBottomTabs 的忠实移植链）：
 *   - SDF 圆角矩形 / 渐度函数          → shaders/sdf.ts
 *   - 封面式 UV 映射（coverUv）        → shaders/sdf.ts (COVER_GLSL)
 *   - 高斯圆盘采样 + 颜色控制（HSV）   → shaders/element-utils.ts
 *   - 主玻璃元素着色器（折射 + 色散）  → shaders/element.ts
 *   - 默认边缘高光（Plus 叠加混合）    → shaders/highlight.ts
 *   - 弹簧物理（临界阻尼 / 欠阻尼）    → renderer/spring.ts
 *   - 底部标签栏参数                   → catalog/build-bottom-tabs.ts
 *
 * 参数对齐：
 *   容器: refractionHeight=24, refractionAmount=-24, blur=8,
 *         saturation=1.5, depthEffect=true, highlight α=0.5 (Default)
 *   指示器: refractionHeight=10, refractionAmount=-14, blur=0,
 *         chromaticAberration=true, dimOverlay(Black/White 0.1),
 *         pressedScale=78/56, springs ζ=0.6/0.7 k=250, 平移弹簧 ζ=1 k=1000
 * ================================================================ */
(function () {
  'use strict';

  /* ---------------- 弹簧常数（renderer/spring.ts） --------------- */
  var SPRING_K = 300;
  var SPRING_ZETA = 0.5;
  var OMEGA_N = Math.sqrt(SPRING_K);
  var OMEGA_D = OMEGA_N * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
  var INDICATOR_POS_K = 1000;              // spring(1f, 1000f) — 临界阻尼
  var INDICATOR_POS_OMEGA = Math.sqrt(INDICATOR_POS_K);
  var PRESS_K = 1000;                      // pressProgress — 临界阻尼
  var PRESS_OMEGA = Math.sqrt(PRESS_K);
  var SCALE_X_K = 250, SCALE_X_ZETA = 0.6; // 指示器 scaleX — 欠阻尼
  var SCALE_Y_K = 250, SCALE_Y_ZETA = 0.7; // 指示器 scaleY — 欠阻尼
  var PRESSED_SCALE = 61 / 56;             // DampedDragAnimation.pressedScale

  function springStepCritical(cur, vel, target, dt, omegaN) {
    var x0 = cur - target, v0 = vel;
    var decay = Math.exp(-omegaN * dt);
    var offset = x0 * decay + (v0 + omegaN * x0) * dt * decay;
    var newVel = -omegaN * x0 * decay + (v0 + omegaN * x0) * (decay - omegaN * dt * decay);
    return { cur: target + offset, vel: newVel };
  }
  function springStepUnderdamped(cur, vel, target, dt, omegaN, zeta) {
    var omegaD = omegaN * Math.sqrt(1 - zeta * zeta);
    var x0 = cur - target, v0 = vel;
    var decay = Math.exp(-zeta * omegaN * dt);
    var cosWd = Math.cos(omegaD * dt), sinWd = Math.sin(omegaD * dt);
    var offset = x0 * decay * cosWd +
      ((v0 + zeta * omegaN * x0) / omegaD) * decay * sinWd;
    var b0 = (v0 + zeta * omegaN * x0) / omegaD;
    var newVel = -zeta * omegaN * offset +
      decay * (-x0 * omegaD * sinWd + b0 * omegaD * cosWd);
    return { cur: target + offset, vel: newVel };
  }

  /* ---------------- GLSL 公共块（sdf.ts 移植） ------------------- */
  var SDF_GLSL = [
    '// sdRoundedRect — 有符号距离场：内负外正边缘为 0',
    'float sdRoundedRect(vec2 coord, vec2 halfSize, float radius) {',
    '    vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));',
    '    float outside = length(max(cornerCoord, 0.0)) - radius;',
    '    float inside = min(max(cornerCoord.x, cornerCoord.y), 0.0);',
    '    return outside + inside;',
    '}',
    '',
    '// gradSdRoundedRect — SDF 梯度（指向外侧），用于折射方向与高光',
    'vec2 gradSdRoundedRect(vec2 coord, vec2 halfSize, float radius) {',
    '    vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));',
    '    if (cornerCoord.x >= 0.0 || cornerCoord.y >= 0.0) {',
    '        vec2 v = max(cornerCoord, vec2(0.0));',
    '        float len = length(v);',
    '        if (len < 1e-6) return vec2(0.0);',
    '        return sign(coord) * (v / len);',
    '    } else {',
    '        float gradX = step(cornerCoord.y, cornerCoord.x);',
    '        return sign(coord) * vec2(gradX, 1.0 - gradX);',
    '    }',
    '}'
  ].join('\n');

  var COVER_GLSL = [
    '// coverUv — 与 body 的 CSS background: cover/center/fixed 完全对齐的采样映射。',
    '// 导航栏画布只是视口的一小块：先把本地像素换算为视口页面像素，再做',
    '// cover 裁剪；纹理以 UNPACK_FLIP_Y 上传（v=0 在图像底部），故需翻转 Y',
    'uniform vec2 uViewportSize;   // 视口尺寸（设备像素）',
    'uniform vec2 uNavOffset;      // 导航画布左上角在视口内的偏移（设备像素）',
    'vec2 coverUv(vec2 canvasPx) {',
    '    vec2 pagePx = uNavOffset + canvasPx;',
    '    float canvasAspect = uViewportSize.x / uViewportSize.y;',
    '    float wpAspect = uWallpaperSize.x / uWallpaperSize.y;',
    '    vec2 uv = pagePx / uViewportSize;',
    '    if (wpAspect > canvasAspect) {',
    '        float s = canvasAspect / wpAspect;',
    '        uv.x = (uv.x - 0.5) * s + 0.5;',
    '    } else {',
    '        float s = wpAspect / canvasAspect;',
    '        uv.y = (uv.y - 0.5) * s + 0.5;',
    '    }',
    '    // UNPACK_FLIP_Y_WEBGL=true 时 v=0 对应图像顶部，与 CSS 方向一致，无需翻转',
    '    return vec2(uv.x, uv.y);',
    '}',
    '',
    '// 1 个视口像素对应的壁纸 UV 尺寸（把模糊半径换算成 UV 偏移）',
    'vec2 canvasPxToUvScale() {',
    '    float canvasAspect = uViewportSize.x / uViewportSize.y;',
    '    float wpAspect = uWallpaperSize.x / uWallpaperSize.y;',
    '    if (wpAspect > canvasAspect) {',
    '        return vec2(canvasAspect / wpAspect, 1.0) / uViewportSize;',
    '    } else {',
    '        return vec2(1.0, wpAspect / canvasAspect) / uViewportSize;',
    '    }',
    '}'
  ].join('\n');

  /* ------------- 高斯圆盘采样生成（element-utils.ts） ----------- */
  function generateGaussianDisc(tapCount) {
    var taps = [];
    if (tapCount <= 1) { taps.push({ x: 0, y: 0, w: 1 }); return taps; }
    var goldenAngle = Math.PI * (3.0 - Math.sqrt(5.0));
    var maxRadius = 3.0;
    var totalW = 0;
    for (var i = 0; i < tapCount; i++) {
      var t = (i + 0.5) / tapCount;
      var r = maxRadius * Math.sqrt(t);
      var angle = i * goldenAngle;
      var x = r * Math.cos(angle), y = r * Math.sin(angle);
      var w = Math.exp(-0.5 * (x * x + y * y));
      taps.push({ x: x, y: y, w: w });
      totalW += w;
    }
    for (var j = 0; j < taps.length; j++) taps[j].w /= totalW;
    return taps;
  }
  function generateBlurGLSL(taps, sampler, uvVar, pxToUvExpr) {
    var code = '';
    for (var i = 0; i < taps.length; i++) {
      code += '    sum += texture2D(' + sampler + ', ' + uvVar + ' + vec2(' +
        taps[i].x.toFixed(6) + ', ' + taps[i].y.toFixed(6) + ') * ' + pxToUvExpr + ') * ' +
        taps[i].w.toFixed(8) + ';\n';
    }
    return code;
  }
  var BLUR_TAPS = 8;
  var DISC_TAPS = generateGaussianDisc(BLUR_TAPS);

  /* ------------- 工具着色器块（element-utils.ts 子集） ---------- */
  function buildUtilsGLSL() {
    var wallpaperBlurCode = generateBlurGLSL(DISC_TAPS, 'uWallpaperSampler', 'uv', 'pxToUv');
    var sceneBlurCode = generateBlurGLSL(DISC_TAPS, 'uBackdrop', 'uv', 'pxToUv');
    return '\
// circleMap — 圆透镜位移映射（AGSL 原版公式）\n\
float circleMap(float x) {\n\
    return 1.0 - sqrt(1.0 - x * x);\n\
}\n\
\n\
// sceneUv — 画布像素(左上原点) → 场景纹理 UV\n\
vec2 sceneUv(vec2 canvasPx) {\n\
    return vec2(canvasPx.x / uCanvasSize.x, 1.0 - canvasPx.y / uCanvasSize.y);\n\
}\n\
\n\
// sampleBackdrop — 高斯圆盘模糊背景采样。\n\
// uSampleWallpaper>0.5 时直接采样干净壁纸（coverUv 对齐 CSS 显示），\n\
// 否则采样场景 FBO（已含容器玻璃层的合成结果）。\n\
vec4 sampleBackdrop(vec2 canvasPx, float radius) {\n\
    if (uSampleWallpaper > 0.5) {\n\
        vec2 uv = coverUv(canvasPx);\n\
        vec4 c;\n\
        if (radius < 0.5) {\n\
            c = texture2D(uWallpaperSampler, uv);\n\
        } else {\n\
            vec2 pxToUv = radius * canvasPxToUvScale();\n\
            vec4 sum = vec4(0.0);\n'
            + wallpaperBlurCode +
'            c = sum;\n\
        }\n\
        // 暗化遮罩(Scrim)：模拟 LayerBackdrop 壁纸+遮罩的合成层，保持不透明\n\
        if (uScrimColor.a > 0.001) {\n\
            c.rgb = uScrimColor.rgb * uScrimColor.a + c.rgb * (1.0 - uScrimColor.a);\n\
            c.a = 1.0;\n\
        }\n\
        return c;\n\
    }\n\
    vec2 uv = sceneUv(canvasPx);\n\
    if (radius < 0.5) {\n\
        return texture2D(uBackdrop, uv);\n\
    }\n\
    vec2 pxToUv = radius / uCanvasSize;\n\
    vec4 sum = vec4(0.0);\n'
    + sceneBlurCode +
'    return sum;\n\
}\n\
\n\
// applyColorControls — ColorFilter.kt colorControlsColorFilter 精确移植\n\
// (saturation 1.5, brightness 0, contrast 1 → 纯饱和度提升 vibrancy)\n\
vec3 applyColorControls(vec3 c, float brightness, float contrast, float saturation) {\n\
    float invSat = 1.0 - saturation;\n\
    float r = 0.213 * invSat;\n\
    float g = 0.715 * invSat;\n\
    float b = 0.072 * invSat;\n\
    float t = (0.5 - contrast * 0.5 + brightness) * 255.0;\n\
    float cs = contrast * saturation;\n\
    float cr = contrast * r;\n\
    float cg = contrast * g;\n\
    float cb = contrast * b;\n\
    vec3 outc;\n\
    outc.r = (cr + cs) * c.r + cg * c.g + cb * c.b + t / 255.0;\n\
    outc.g = cr * c.r + (cg + cs) * c.g + cb * c.b + t / 255.0;\n\
    outc.b = cr * c.r + cg * c.g + (cb + cs) * c.b + t / 255.0;\n\
    return outc;\n\
}';
  }

  /* ------------- 主元素着色器（element.ts 忠实移植） ------------ */
  function buildElementFS() {
    return '\
precision highp float;\n\
\n\
uniform sampler2D uBackdrop;          // 场景 FBO（指示器采样容器玻璃结果）\n\
uniform sampler2D uWallpaperSampler;  // 壁纸纹理（cover-fit）\n\
uniform vec2  uCanvasSize;            // 画布尺寸 px\n\
uniform vec2  uWallpaperSize;         // 壁纸纹理自然尺寸 px\n\
uniform vec2  uElementOffset;         // 元素左上角（画布 px，缩放后矩形）\n\
uniform vec2  uElementSize;           // 元素尺寸（缩放后）\n\
uniform vec4  uCornerRadii;           // 四角半径（原始空间）\n\
uniform vec2  uOriginalSize;          // 原始尺寸（未经 graphicsLayer 缩放）\n\
uniform float uOriginalCornerRadius;  // 原始角半径\n\
uniform vec2  uLayerScale;            // graphicsLayer scaleX/scaleY\n\
uniform float uRefractionHeight;      // 折射高度 px（原始空间）\n\
uniform float uRefractionAmount;      // 折射强度 px\n\
uniform float uDepthEffect;           // 0 或 1（深度归一）\n\
uniform float uChromaticAberration;   // 0 或 1（7 通道色散）\n\
uniform float uBlurRadius;            // 背景模糊半径 px\n\
uniform float uSaturation;            // 饱和度（vibrancy=1.5）\n\
uniform float uBrightness;            // 亮度偏移\n\
uniform float uContrast;              // 对比度\n\
uniform vec4  uTintColor;             // Hue 混合染色 rgba\n\
uniform vec4  uSurfaceColor;          // 表面色 drawRect rgba\n\
uniform vec4  uScrimColor;            // 暗化遮罩 rgba（a=0 关闭）\n\
uniform float uSampleWallpaper;       // 0=场景FBO 1=壁纸直采\n\
// uViewportSize / uNavOffset 已在 COVER_GLSL 中声明（coverUv 使用）\n\
// 指示器 onDrawSurface 暗化叠层（LiquidBottomTabs.kt）：\n\
//   drawRect(dimColor 0.1, alpha=1-progress) + drawRect(Black 0.03*progress)\n\
uniform vec4  uDimOverlay;            // rgb=主题明暗色 a=0.1\n\
uniform float uPressDarken;           // pressProgress\n\
uniform float uOpacity;               // 最终不透明度（形状遮罩 × 此值）\n\
\n'
+ SDF_GLSL + '\n\
\n'
+ COVER_GLSL + '\n\
\n'
+ buildUtilsGLSL() + '\n\
\n\
void main() {\n\
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);\n\
    vec2 elementCenter = uElementOffset + uElementSize * 0.5;\n\
    vec2 centeredScreen = screenCoord - elementCenter;\n\
    vec2 layerScale = max(uLayerScale, vec2(1e-4));\n\
    vec2 centeredOrig = centeredScreen / layerScale;\n\
    vec2 origHalfSize = uOriginalSize * 0.5;\n\
    float origRadius = uOriginalCornerRadius;\n\
\n\
    // --- 形状裁剪 + 边缘抗锯齿（±1.0 device px 带宽 = 2px 过渡带，配合 antialias:true 消除锯齿）---\n\
    float sd = sdRoundedRect(centeredOrig, origHalfSize, origRadius);\n\
    if (sd > 1.0) discard;\n\
    float edgeAlpha = 1.0 - smoothstep(-1.0, 1.0, sd);\n\
\n\
    // --- 1. 背景采样（折射前） ---\n\
    vec4 backdrop = sampleBackdrop(screenCoord, uBlurRadius);\n\
    vec3 color = applyColorControls(backdrop.rgb, uBrightness, uContrast, uSaturation);\n\
    float alpha = backdrop.a;\n\
\n\
    // --- 2. 透镜折射（SDF + circleMap，忠实 AGSL 原版） ---\n\
    if (uRefractionHeight > 0.5 && (-sd) < uRefractionHeight) {\n\
        float sdClamped = min(sd, 0.0);\n\
        float d = circleMap(1.0 - (-sdClamped) / uRefractionHeight) * uRefractionAmount;\n\
\n\
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));\n\
        vec2 grad = gradSdRoundedRect(centeredOrig, origHalfSize, gradRadius);\n\
        // AGSL: normalize(grad + depthEffect * normalize(centeredCoord))\n\
        vec2 depthVec = vec2(0.0);\n\
        if (uDepthEffect > 0.5) {\n\
            float dirLen = length(centeredOrig);\n\
            if (dirLen > 1e-6) depthVec = centeredOrig / dirLen;\n\
        }\n\
        vec2 gradSum = grad + uDepthEffect * depthVec;\n\
        float gradLen = length(gradSum);\n\
        if (gradLen > 1e-6) grad = gradSum / gradLen;\n\
\n\
        // 折射偏移：原始空间计算，再映射回屏幕空间（graphicsLayer 语义）\n\
        vec2 refractedOffsetOrig = d * grad;\n\
        vec2 refractedOffsetScreen = refractedOffsetOrig * layerScale;\n\
        vec2 refractedScreen = screenCoord + refractedOffsetScreen;\n\
\n\
        if (uChromaticAberration > 0.5) {\n\
            // 简化 3 通道色散（R/G/B），比 7 通道快 57%\n\
            float dispersionIntensity = 1.0 *\n\
                ((centeredOrig.x * centeredOrig.y) / (origHalfSize.x * origHalfSize.y));\n\
            vec2 dispersedOffsetScreen = refractedOffsetScreen * dispersionIntensity;\n\
\n\
            vec4 sRed   = sampleBackdrop(refractedScreen + dispersedOffsetScreen, uBlurRadius);\n\
            vec4 sGreen = sampleBackdrop(refractedScreen, uBlurRadius);\n\
            vec4 sBlue  = sampleBackdrop(refractedScreen - dispersedOffsetScreen, uBlurRadius);\n\
\n\
            vec3 dispColor = vec3(sRed.r, sGreen.g, sBlue.b);\n\
            float dispAlpha = (sRed.a + sGreen.a + sBlue.a) / 3.0;\n\
\n\
            color = applyColorControls(dispColor, uBrightness, uContrast, uSaturation);\n\
            alpha = dispAlpha;\n\
        } else {\n\
            vec4 refracted = sampleBackdrop(refractedScreen, uBlurRadius);\n\
            color = applyColorControls(refracted.rgb, uBrightness, uContrast, uSaturation);\n\
            alpha = refracted.a;\n\
        }\n\
    }\n\
\n\
    // --- 3. 表面染色：Hue 混合 + 0.75α SrcOver（LiquidButton onDrawSurface） ---\n\
    if (uTintColor.a > 0.001) {\n\
        color = mix(color, uTintColor.rgb, 0.75 * uTintColor.a);\n\
    }\n\
    // --- 4. 表面色叠加（仅影响 RGB，alpha 由 uOpacity 控制） ---\n\
    if (uSurfaceColor.a > 0.001) {\n\
        color = mix(color, uSurfaceColor.rgb, uSurfaceColor.a);\n\
    }\n\
    // --- 4b. 指示器暗化叠层（仅影响 RGB） ---\n\
    if (uDimOverlay.a > 0.001) {\n\
        color = uDimOverlay.rgb * uDimOverlay.a + color * (1.0 - uDimOverlay.a);\n\
    }\n\
    if (uPressDarken > 0.001) {\n\
        color = mix(color, vec3(1.0), 0.5 * uPressDarken);\n\
    }\n\
\n\
    gl_FragColor = vec4(color, uOpacity * edgeAlpha);\n\
}';
  }

  /* ------------- 边缘高光着色器（highlight.ts Default 模式） ---- */
  function buildRimFS() {
    return '\
precision highp float;\n\
\n\
uniform vec2  uCanvasSize;\n\
uniform vec2  uOffset;               // 缩放后左上角 px\n\
uniform vec2  uSize;                 // 缩放后尺寸 px\n\
uniform vec4  uHighlightColor;       // rgb + 1.0\n\
uniform float uHighlightAngle;       // 弧度\n\
uniform float uHighlightFalloff;\n\
uniform float uHighlightAlpha;\n\
uniform float uHighlightStrokeWidth; // ceil(width*dpr)*2 设备像素\n\
uniform float uHighlightBlur;        // BlurMaskFilter σ px\n\
uniform vec2  uOriginalSize;\n\
uniform float uOriginalCornerRadius;\n\
uniform vec2  uLayerScale;\n\
\n'
+ SDF_GLSL + '\n\
\n\
void main() {\n\
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);\n\
    vec2 elementCenter = uOffset + uSize * 0.5;\n\
    vec2 centeredScreen = screenCoord - elementCenter;\n\
    vec2 layerScale = max(uLayerScale, vec2(1e-4));\n\
    vec2 centeredOrig = centeredScreen / layerScale;\n\
    vec2 origHalfSize = uOriginalSize * 0.5;\n\
\n\
    float sd = sdRoundedRect(centeredOrig, origHalfSize, uOriginalCornerRadius);\n\
\n\
    // clipOutline — 只保留形状内部（外侧半描边被裁掉）\n\
    if (sd > 0.0) discard;\n\
\n\
    // 描边掩膜：硬边缘带 [-strokeHalf,+strokeHalf] 再做 3-tap σ 间隔高斯卷积，\n\
    // 对应 HighlightModifier.kt Stroke + BlurMaskFilter(NORMAL)；裁剪使峰值减半\n\
    float strokeHalf = uHighlightStrokeWidth * 0.5;\n\
    float sigma = max(uHighlightBlur, 0.1);\n\
    float strokeMask = 0.0;\n\
    float wSum = 0.0;\n\
    for (int i = -1; i <= 1; i++) {\n\
        float offset = float(i) * sigma;\n\
        float sampleSd = sd - offset;\n\
        float hard = (abs(sampleSd) < strokeHalf) ? 1.0 : 0.0;\n\
        float w = exp(-0.5 * (offset * offset) / (sigma * sigma));\n\
        strokeMask += hard * w;\n\
        wSum += w;\n\
    }\n\
    strokeMask /= wSum;\n\
    strokeMask *= 0.5;\n\
\n\
    // Default 模式：intensity = pow(|dot(grad, normal)|, falloff)，Plus 加法混合\n\
    float gradRadius = min(uOriginalCornerRadius * 1.5, min(origHalfSize.x, origHalfSize.y));\n\
    vec2 grad = gradSdRoundedRect(centeredOrig, origHalfSize, gradRadius);\n\
    vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));\n\
    float d = dot(grad, normal);\n\
    float intensity = pow(abs(d), uHighlightFalloff);\n\
    vec3 c = uHighlightColor.rgb * intensity * strokeMask * uHighlightAlpha;\n\
    gl_FragColor = vec4(c, 1.0);\n\
}';
  }

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'void main() {',
    '    gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* ==================== 引擎 =================================== */

  var engine = null;

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
  }

  function Engine(navEl, opts) {
    var self = this;
    this.nav = navEl;
    this.opts = opts || {};
    this.order = opts.order || [];
    this.onSelect = opts.onSelect || null;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.destroyed = false;
    this.ready = false;

    // --- Canvas 注入 ---
    var canvas = document.createElement('canvas');
    canvas.className = 'nav-glass-canvas';
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:0;';
    navEl.insertBefore(canvas, navEl.firstChild);
    this.canvas = canvas;

    // DOM 内容抬高到 WebGL 层之上
    for (var n = navEl.firstElementChild; n; n = n.nextElementSibling) {
      if (n !== canvas && getComputedStyle(n).position === 'static') {
        n.style.position = 'relative';
        n.style.zIndex = '2';
      }
    }

    var glAttrs = { alpha: true, premultipliedAlpha: false, antialias: true, depth: false, stencil: false };
    var gl = canvas.getContext('webgl', glAttrs) || canvas.getContext('experimental-webgl', glAttrs);
    if (!gl) { console.warn('[LiquidGlass] WebGL 不可用'); return; }
    this.gl = gl;

    // --- 全屏四边形缓冲 ---
    var quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.quadBuffer = quadBuf;

    // --- 着色器程序 ---
    var elFs = buildElementFS();
    var rimFs = buildRimFS();
    try {
      this.elemProgram = this.createProgram(VERT_SRC, elFs);
      this.rimProgram = this.createProgram(VERT_SRC, rimFs);
    } catch (e) {
      console.error('[LiquidGlass] 着色器编译失败', e);
      return;
    }
    this.elemLoc = this.collectUniforms(this.elemProgram, ['aPos', 'uBackdrop', 'uWallpaperSampler', 'uCanvasSize',
      'uWallpaperSize', 'uElementOffset', 'uElementSize', 'uCornerRadii', 'uOriginalSize', 'uOriginalCornerRadius',
      'uLayerScale', 'uRefractionHeight', 'uRefractionAmount', 'uDepthEffect', 'uChromaticAberration',
      'uBlurRadius', 'uSaturation', 'uBrightness', 'uContrast', 'uTintColor', 'uSurfaceColor',
      'uScrimColor', 'uSampleWallpaper', 'uDimOverlay', 'uPressDarken', 'uViewportSize', 'uNavOffset', 'uOpacity']);
    this.rimLoc = this.collectUniforms(this.rimProgram, ['aPos', 'uCanvasSize', 'uOffset', 'uSize',
      'uHighlightColor', 'uHighlightAngle', 'uHighlightFalloff', 'uHighlightAlpha',
      'uHighlightStrokeWidth', 'uHighlightBlur', 'uOriginalSize', 'uOriginalCornerRadius', 'uLayerScale']);

    this.copyProgram = this.createProgram(VERT_SRC,
      'precision highp float;' +
      'uniform sampler2D uTexture;' +
      'uniform vec2 uTexSize;' +
      'uniform float uAlpha;' +
      'void main(){ vec4 tex = texture2D(uTexture, gl_FragCoord.xy / uTexSize); gl_FragColor = vec4(tex.rgb, tex.a * uAlpha); }');
    this.copyLoc = {
      aPos: gl.getAttribLocation(this.copyProgram, 'aPos'),
      uTexture: gl.getUniformLocation(this.copyProgram, 'uTexture'),
      uTexSize: gl.getUniformLocation(this.copyProgram, 'uTexSize'),
      uAlpha: gl.getUniformLocation(this.copyProgram, 'uAlpha')
    };

    // --- 状态 ---
    // 双 FBO ping-pong：fboA 仅作为 Pass1 的采样源占位（避免渲染目标与
    // 采样纹理相同触发 WebGL 反馈环 INVALID_OPERATION），容器玻璃渲入
    // fboB，再由 fboB 呈现到屏幕 / 供指示器折射采样。
    this.fboA = null; this.fboATex = null;
    this.fboB = null; this.fboBTex = null;
    this.fboW = 0; this.fboH = 0;
    this.wallpaperTex = null;
    this.wallpaperSize = [1920, 1080];
    this.isLightTheme = true;
    this.themeDirty = true;

    // 动画状态（bottom tabs 物理量）
    this.tabCount = this.nav.querySelectorAll('.nav-item[data-view]').length;
    this.fraction = 0;          // 指示器滑轨位置（浮点 tab 索引）
    this.fractionVel = 0;
    this.targetFraction = 0;
    this.press = { p: 0, v: 0, t: 0 };   // pressProgress
    this.scaleX = 1; this.scaleXVel = 0;
    this.scaleY = 1; this.scaleYVel = 0;
    this.needsRender = true;
    this.animating = false;
    this.lastTime = 0;

    // uniform 缓存（避免相同 uniform 重复写入 GPU）
    this._elUniformCache = {};
    this._rimUniformCache = {};

    // 预分配静态数组，避免每帧 GC
    this._zeroTint = [0, 0, 0, 0];
    this._zeroDim = [0, 0, 0, 0];
    this._indicatorSurface = [0.98, 0.98, 0.98, 0.80];

    // 布局几何（CSS px）
    this.slotX = 0; this.slotY = 0; this.slotW = 0; this.slotH = 0;
    this.btnRects = [];

    // --- 事件绑定 ---
    this.bindPointer();
    this.observeTheme();

    this._onResize = function () { self.layoutDirty = true; self.invalidate(); };
    window.addEventListener('resize', this._onResize);
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this._onResize);
      this.ro.observe(navEl);
    }

    this.ready = true;
    this._tickBound = this.tick.bind(this);
    this.loadWallpaper();
    this.measure();
  }

  Engine.prototype.createShader = function (type, src) {
    var gl = this.gl;
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  };

  Engine.prototype.createProgram = function (vsSrc, fsSrc) {
    var gl = this.gl;
    var vs = this.createShader(gl.VERTEX_SHADER, vsSrc);
    var fs = this.createShader(gl.FRAGMENT_SHADER, fsSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(log);
    }
    return prog;
  };

  Engine.prototype.collectUniforms = function (prog, names) {
    var loc = {};
    for (var i = 0; i < names.length; i++) {
      var nm = names[i];
      loc[nm] = nm === 'aPos'
        ? this.gl.getAttribLocation(prog, nm)
        : this.gl.getUniformLocation(prog, nm);
    }
    return loc;
  };

  /* ---------------- 壁纸加载（body 背景图同源抓取） -------------- */
  Engine.prototype.loadWallpaper = function () {
    var self = this;
    this.detectTheme();
    var bodyBg = getComputedStyle(document.body).backgroundImage;
    var url = null;
    var m = bodyBg && bodyBg.match(/url\(["']?(.+?)["']?\)/);
    if (m) url = m[1];
    if (!url) { this.useProceduralWallpaper(); return; }

    var img = new Image();
    img.onload = function () {
      if (self.destroyed) return;
      var gl = self.gl;
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        self.wallpaperTex = tex;
        self.wallpaperSize = [img.naturalWidth, img.naturalHeight];
      } catch (e) {
        // file:// 跨源污染等场景回退到程序化纹理
        self.useProceduralWallpaper();
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      self.invalidate();
    };
    img.onerror = function () { self.useProceduralWallpaper(); };
    img.src = url;
  };

  // 主题切换时重载对应壁纸（data-effective 变更驱动）
  Engine.prototype.observeTheme = function () {
    var self = this;
    var mo = new MutationObserver(function () {
      var eff = document.body.getAttribute('data-effective') || 'light';
      if ((eff === 'light') !== self.isLightTheme) {
        self.themeDirty = true;
        self.invalidate();
      }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-effective'] });
  };

  Engine.prototype.detectTheme = function () {
    this.isLightTheme = (document.body.getAttribute('data-effective') || 'light') !== 'dark';
    // 大胶囊背景改为与右侧赛季按钮一致的半透明黑色（替代液态玻璃着色）
    // 浅色模式: rgba(0,0,0,0.4)，深色模式: rgba(0,0,0,0.5)
    this._containerSurface = this.isLightTheme
      ? [0, 0, 0, 0.40]
      : [0, 0, 0, 0.50];
    this._glassAlpha = this.isLightTheme ? 1.0 : 1.0;  // 颜色 alpha 由 surface 混合控制，此处不再二次衰减
    this._indicatorDim = this.isLightTheme ? [1, 1, 1, 0.35] : [1, 1, 1, 0.20];
  };

  Engine.prototype.useProceduralWallpaper = function () {
    var cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 1024;
    var ctx = cv.getContext('2d');
    var grd = ctx.createLinearGradient(0, 0, 1024, 1024);
    if (this.isLightTheme) {
      grd.addColorStop(0, '#cfe4f7'); grd.addColorStop(0.5, '#e8d9ef'); grd.addColorStop(1, '#fdf3dd');
    } else {
      grd.addColorStop(0, '#101828'); grd.addColorStop(0.5, '#1b2438'); grd.addColorStop(1, '#2a2130');
    }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 1024, 1024);
    var gl = this.gl;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    this.wallpaperTex = tex;
    this.wallpaperSize = [1024, 1024];
    this.invalidate();
  };

  /* ---------------- 布局测量 ------------------------------------ */
  Engine.prototype.measure = function () {
    var navRect = this.canvas.getBoundingClientRect();
    // 视口相对偏移（导航为 fixed 定位，滚动不影响）——供 coverUv 对齐 CSS 壁纸
    this.navLeft = navRect.left;
    this.navTop = navRect.top;
    var dpr = this.dpr;
    var pad = 6 * dpr;
    // 容器比指示器区域四周多呼吸空间：与 nav padding 对齐，四边等距
    var edgePad = 6 * dpr;
    // canvas 高度 = nav 高度（容器在 nav 内部居中）
    var baseH = Math.max(1, Math.round(navRect.height * dpr));
    var ch = baseH;
    var cw = Math.max(1, Math.round(navRect.width * dpr));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    this.canvas.style.top = '0px';
    this.canvas.style.height = (baseH / dpr) + 'px';

    var items = this.nav.querySelectorAll('.nav-item[data-view]');
    this.btnEls = [];        // 缓存按钮 DOM 元素
    this.btnRects = [];
    this.btnCenters = [];   // 每个按钮中心 X（设备像素）
    this.btnWidths = [];    // 每个按钮宽度（设备像素）
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      var lx = (r.left - navRect.left) * dpr;
      var rx = (r.right - navRect.left) * dpr;
      this.btnEls.push(items[i]);
      this.btnRects.push({ left: lx, right: rx });
      this.btnCenters.push((lx + rx) * 0.5);
      this.btnWidths.push(rx - lx);
    }
    // 初始化颜色缓存
    this._lastColors = new Array(items.length).fill('');
    this._lastColorFrac = -1;
    // 容器高度 = 导航栏的 2/3，垂直居中
    this.containerH = Math.round(baseH * 2 / 3);
    this.containerY = Math.round((baseH - this.containerH) / 2);
    // 指示器区域 = 容器内减去四周 edgePad
    this.slotY = this.containerY + edgePad;
    this.slotH = Math.max(1, this.containerH - 2 * edgePad);
    this.edgePad = edgePad;
    // 容器宽度 = 导航栏全宽
    this.containerL = 0;
    this.containerR = cw;
    this.containerW = cw;

    this.resizeFBOs(cw, ch);
    this.layoutDirty = false;
    this._elUniformCache = {};
    this._rimUniformCache = {};
    this.updateColors();
  };

  // 根据浮点 tab 索引计算胶囊中心 X 与宽度（按钮中心线性插值）
  Engine.prototype.pillGeom = function (frac) {
    var n = this.btnCenters.length;
    if (n === 0) return { cx: this.containerL + this.containerW * 0.5, w: 0 };
    if (frac <= 0) return { cx: this.btnCenters[0], w: this.btnWidths[0] };
    if (frac >= n - 1) return { cx: this.btnCenters[n - 1], w: this.btnWidths[n - 1] };
    var i = Math.floor(frac);
    var t = frac - i;
    var cx = this.btnCenters[i] * (1 - t) + this.btnCenters[i + 1] * t;
    var w = this.btnWidths[i] * (1 - t) + this.btnWidths[i + 1] * t;
    return { cx: cx, w: w };
  };

  Engine.prototype.resizeFBOs = function (w, h) {
    if (this.fboW === w && this.fboH === h && this.fboA && this.fboB) return;
    this._elUniformCache = {};
    this._rimUniformCache = {};
    var gl = this.gl;
    function makeFBO() {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fb: fb, tex: tex };
    }
    if (this.fboA) gl.deleteFramebuffer(this.fboA);
    if (this.fboATex) gl.deleteTexture(this.fboATex);
    if (this.fboB) gl.deleteFramebuffer(this.fboB);
    if (this.fboBTex) gl.deleteTexture(this.fboBTex);
    var a = makeFBO();
    this.fboA = a.fb; this.fboATex = a.tex;
    var b = makeFBO();
    this.fboB = b.fb; this.fboBTex = b.tex;
    this.fboW = w; this.fboH = h;
  };

  /* ---------------- 交互（指针按压 + 拖拽滑动） ------------------ */
  Engine.prototype.bindPointer = function () {
    var self = this;
    var dragStartX = 0, isDragging = false;
    var activeBtn = null;

    // 在导航栏整体上监听 pointerdown，支持任意位置按下并拖拽
    this._onNavPointerDown = function (e) {
      // 忽略非主键（如右键）
      if (e.button != null && e.button !== 0) return;
      self.press.t = 1;
      // 找到按下位置对应的按钮（用于按压视觉反馈）
      var target = e.target;
      while (target && target !== self.nav && target.tagName !== 'BODY') {
        if (target.classList && target.classList.contains('nav-item')) {
          activeBtn = target;
          self.pressBtn = target;
          break;
        }
        target = target.parentNode;
      }
      if (!activeBtn) {
        activeBtn = null;
        self.pressBtn = null;
      }
      isDragging = false;
      dragStartX = e.clientX;
      self._dragged = false;
      self.animate();
    };
    this.nav.addEventListener('pointerdown', this._onNavPointerDown);

    // 拖拽移动：实时更新指示器位置
    this._onPointerMove = function (e) {
      if (!self.press.t) return;
      var navRect = self.nav.getBoundingClientRect();
      var localX = (e.clientX - navRect.left) * self.dpr;
      var frac = self.fracFromX(localX);
      // 移动超过 3px 视为拖拽
      if (!isDragging && Math.abs(e.clientX - dragStartX) > 3) isDragging = true;
      if (isDragging) {
        self.targetFraction = Math.max(0, Math.min(self.tabCount - 1, frac));
        self.animate();
      }
    };
    window.addEventListener('pointermove', this._onPointerMove);

    // 结束：拖拽则吸附，点击则切换到按下的按钮
    this._onPointerUp = function (e) {
      if (!self.press.t && !self.pressBtn && !isDragging) return;
      if (isDragging) {
        // 拖拽模式：吸附到最近标签
        var snapped = Math.round(self.targetFraction);
        snapped = Math.max(0, Math.min(self.tabCount - 1, snapped));
        self.targetFraction = snapped;
        var view = self.order[snapped];
        if (view && self.onSelect) self.onSelect(view);
        self._dragged = true;
      } else if (self.pressBtn) {
        // 点击模式：直接切换到按下的按钮
        var view = self.pressBtn.dataset.view;
        var idx = self.order.indexOf(view);
        if (idx >= 0) self.setTabByIndex(idx);
        if (view && self.onSelect) self.onSelect(view);
        self._dragged = false;
      }
      self.endPress();
      isDragging = false;
      activeBtn = null;
    };
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);

    // 点击已由 pointerup 处理，此 handler 仅作兜底（不做任何事）
    var items = this.nav.querySelectorAll('.nav-item[data-view]');
    items.forEach(function (btn, idx) {
      btn.addEventListener('click', function () {
        // 空实现：pointerup 已处理切换逻辑
      });
    });

    // hash 直接跳转时同步指示器
    this.syncFromHash = function () {
      var idx = self.order.indexOf(location.hash.slice(1));
      if (idx >= 0) self.setTabByIndex(idx);
    };
  };

  // 根据局部 X 坐标（设备像素）计算浮点 tab 索引
  Engine.prototype.fracFromX = function (localX) {
    var centers = this.btnCenters;
    var n = centers.length;
    if (n === 0) return 0;
    if (localX <= centers[0]) return 0;
    if (localX >= centers[n - 1]) return n - 1;
    // 在相邻两个中心间线性插值
    for (var i = 0; i < n - 1; i++) {
      if (localX >= centers[i] && localX <= centers[i + 1]) {
        var t = (localX - centers[i]) / (centers[i + 1] - centers[i]);
        return i + t;
      }
    }
    return 0;
  };

  Engine.prototype.endPress = function () {
    this.press.t = 0;
    this.pressBtn = null;
    this.animate();
  };

  Engine.prototype.setTabByIndex = function (idx) {
    this.targetFraction = idx;
    this.animate();
  };

  /* ---------------- 动画帧循环 ---------------------------------- */
  Engine.prototype.animate = function () {
    if (!this.ready || this.animating || this.destroyed) return;
    this.animating = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this._tickBound);
  };

  Engine.prototype.invalidate = function () {
    this.needsRender = true;
    this.animate();
  };

  Engine.prototype.tick = function (now) {
    if (this.destroyed) return;
    var dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    var active = false;

    // --- 指示器位置：spring(1, 1000) 临界阻尼 ---
    if (Math.abs(this.targetFraction - this.fraction) > 0.0001 || Math.abs(this.fractionVel) > 0.002) {
      var prevFrac = this.fraction;
      var s = springStepCritical(this.fraction, this.fractionVel, this.targetFraction, dt, INDICATOR_POS_OMEGA);
      this.fraction = s.cur;
      this.fractionVel = s.vel;
      // 压速度估计（用于 squash-stretch）
      var span = Math.max(1, this.tabCount - 1);
      var instV = dt > 0 ? (this.fraction - prevFrac) / dt : 0;
      this.slideVelNorm = (this.slideVelNorm || 0) * 0.8 + (instV / span) * 0.2;
      active = true;
    } else {
      this.slideVelNorm = 0;
    }

    // --- pressProgress：临界阻尼 spring(1,1000) ---
    if (Math.abs(this.press.t - this.press.p) > 0.0005 || Math.abs(this.press.v) > 0.02) {
      var ps = springStepCritical(this.press.p, this.press.v, this.press.t, dt, PRESS_OMEGA);
      this.press.p = ps.cur;
      this.press.v = ps.vel;
      active = true;
    }

    // --- 指示器 scaleX/Y：欠阻尼 spring(0.6/0.7, 250)，目标 lerp(1, 78/56, p) ---
    var sxTarget = 1 + (PRESSED_SCALE - 1) * this.press.p;
    var syTarget = sxTarget;
    if (Math.abs(sxTarget - this.scaleX) > 0.0005 || Math.abs(this.scaleXVel) > 0.01 ||
        Math.abs(syTarget - this.scaleY) > 0.0005 || Math.abs(this.scaleYVel) > 0.01) {
      var ox = Math.sqrt(SCALE_X_K), oy = Math.sqrt(SCALE_Y_K);
      var sx = springStepUnderdamped(this.scaleX, this.scaleXVel, sxTarget, dt, ox, SCALE_X_ZETA);
      var sy = springStepUnderdamped(this.scaleY, this.scaleYVel, syTarget, dt, oy, SCALE_Y_ZETA);
      this.scaleX = sx.cur; this.scaleXVel = sx.vel;
      this.scaleY = sy.cur; this.scaleYVel = sy.vel;
      active = true;
    }

    // 颜色更新（仅在胶囊位置变化时触发 DOM 更新）
    var colorChanged = this.updateColors();
    if (colorChanged) active = true;

    if (active || this.needsRender || this.themeDirty) {
      this.render(dt);
      this.needsRender = false;
      requestAnimationFrame(this._tickBound);
    } else {
      this.animating = false;
    }
  };

  /* ---------------- 颜色更新（仅在必要时调用） -------------------- */
  Engine.prototype.updateColors = function () {
    var n = this.btnCenters.length;
    if (n === 0) return false;
    // 如果胶囊位置没变，跳过计算
    if (this._lastColorFrac === this.fraction) return false;
    this._lastColorFrac = this.fraction;
    var pill = this.pillGeom(this.fraction);
    var pLeft = pill.cx - pill.w * 0.5;
    var pRight = pill.cx + pill.w * 0.5;
    var prevColors = this._lastColors;
    var changed = false;
    for (var bi = 0; bi < n; bi++) {
      var bCx = this.btnCenters[bi];
      var bW = this.btnWidths[bi];
      var bLeft = bCx - bW * 0.5;
      var bRight = bCx + bW * 0.5;
      var overlap = Math.max(0, Math.min(pRight, bRight) - Math.max(pLeft, bLeft));
      var t = bW > 0 ? Math.max(0, Math.min(1, overlap / bW)) : 0;
      var r = Math.round(255 * (1 - t));
      var a = 0.72 * (1 - t) + 1.0 * t;
      var colorStr = 'rgba(' + r + ',' + r + ',' + r + ',' + a.toFixed(3) + ')';
      if (prevColors[bi] !== colorStr) {
        prevColors[bi] = colorStr;
        this.btnEls[bi].style.color = colorStr;
        changed = true;
      }
    }
    return changed;
  };

  /* ---------------- 渲染管线 ------------------------------------ */
  Engine.prototype.render = function (dt) {
    var gl = this.gl;
    var cw = this.canvas.width, chh = this.canvas.height;
    if (cw <= 0 || chh <= 0) return;
    if (this.themeDirty) { this.themeDirty = false; this.detectTheme(); this.loadWallpaper(); }
    if (this.layoutDirty) this.measure();

    this.resizeFBOs(cw, chh);

    // ===== Pass 1: 容器玻璃 → scene FBO (fboB) =====
    // 采样源绑定 fboATex（占位，壁纸路径实际不读取它），
    // 渲染目标 fboBTex —— 二者不同，规避反馈环。
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Pass1 直接替换 FBO 内容：ONE/ZERO 避免半透明玻璃被自身 alpha 二次衰减
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);

    // —— 容器胶囊（壁纸直采路径 + 半透明黑色表面色覆盖 = 右侧赛季按钮风格）——
    // 容器高度 = nav 的 2/3，垂直居中
    var contL = this.containerL / this.dpr, contT = this.containerY / this.dpr;
    var contW = this.containerW / this.dpr, contH = this.containerH / this.dpr;
    this.drawElement({
      sampleWallpaper: true,
      x: contL, y: contT, w: contW, h: contH,
      cornerRadius: contH / 2,
      refractionHeight: 0, refractionAmount: 0,          // 去折射变形，纯磨砂半透明
      blurRadius: 12, saturation: 1.0, brightness: 0, contrast: 1, // 匹配 backdrop-filter: blur(12px)
      depthEffect: 0, chromaticAberration: 0,            // 关闭色散/景深特效
      tint: this._zeroTint,
      surface: this._containerSurface,                   // 半透明黑色（右侧按钮同款）
      dim: this._zeroDim, pressDarken: 0,
      layerScaleX: 1, layerScaleY: 1,
      opacity: 1.0
    });

    // —— 容器边缘高光 ——
    this.drawRim({
      x: contL, y: contT, w: contW, h: contH,
      cornerRadius: contH / 2,
      alpha: 0.35, strokeWidth: Math.ceil(0.5 * this.dpr) * 2, blurSigma: 0.25 * this.dpr,
      originalSize: [contW, contH],
      layerScaleX: 1, layerScaleY: 1
    });

    // ===== Present: scene FBO → 屏幕 =====
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, chh);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.copyProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.copyLoc.aPos);
    gl.vertexAttribPointer(this.copyLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboBTex);
    gl.uniform1i(this.copyLoc.uTexture, 0);
    gl.uniform2f(this.copyLoc.uTexSize, this.fboW, this.fboH);
    gl.uniform1f(this.copyLoc.uAlpha, this._glassAlpha);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ===== Pass 2: 滑动指示器胶囊（采样场景 FBO = 玻璃套玻璃折射）=====
    var frac = this.fraction;
    var geom = this.pillGeom(frac);
    var baseCX = geom.cx, basePW = geom.w;
    // 指示器 = 容器内区域，四边距容器等距 edgePad
    var basePH = this.containerH - 2 * this.edgePad;           // 指示器高
    var cy = this.containerY + this.containerH / 2;        // 垂直居中于容器
    // 第一个标签：左边距 = edgePad（与上下边距相等）
    if (frac <= 0) {
      var leftEdge = baseCX - basePW / 2;
      if (leftEdge < this.edgePad) {
        baseCX += (this.edgePad - leftEdge);
      }
      // 最后一个标签：右边距 = edgePad
    } else if (frac >= this.btnCenters.length - 1) {
      var rightEdge = baseCX + basePW / 2;
      var maxRight = this.containerW - this.edgePad;
      if (rightEdge > maxRight) {
        baseCX -= (rightEdge - maxRight);
      }
    }
    // squash & stretch：scaleSpring 目标 × 速度驱动的挤压变形
    var vn = Math.max(-1.2, Math.min(1.2, (this.slideVelNorm || 0)));
    var sx = this.scaleX * (1 + Math.max(-0.08, Math.min(0.08, vn * 0.3)));
    var sy = this.scaleY * (1 - Math.max(-0.08, Math.min(0.08, vn * 0.1)));
    var pw = basePW * sx, ph = basePH * sy;
    // 除以 dpr 转 CSS 像素，drawElement 内部会乘回 dpr
    var ix = (baseCX - pw / 2) / this.dpr;
    var iy = (cy - ph / 2) / this.dpr;
    var iw = pw / this.dpr;
    var ih = ph / this.dpr;
    var icr = basePH / 2 / this.dpr;

    var prog = this.press.p;
    this.drawElement({
      sampleWallpaper: false,
      backdropTex: this.fboBTex,
      x: ix, y: iy, w: iw, h: ih,
      cornerRadius: icr,
      refractionHeight: 10 * prog, refractionAmount: -14 * prog,
      blurRadius: 0, saturation: 1, brightness: 0, contrast: 1,
      depthEffect: 0, chromaticAberration: 1,
      tint: this._zeroTint,
      surface: this._indicatorSurface,
      dim: this._indicatorDim,
      dimMulByPress: true,
      pressDarken: prog,
      originalSize: [iw, ih],
      layerScaleX: sx, layerScaleY: sy
    });

    // —— 指示器边缘高光：alpha = 0.5 * pressProgress ——
    if (prog > 0.003) {
      this.drawRim({
        x: ix, y: iy, w: iw, h: ih,
        cornerRadius: icr,
        alpha: 0.5 * prog,
        strokeWidth: Math.ceil(0.5 * this.dpr) * 2, blurSigma: 0.25 * this.dpr,
        originalSize: [iw, ih],
        layerScaleX: sx, layerScaleY: sy
      });
    }

    // 恢复混合状态，供后续拷贝使用
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  Engine.prototype._setU1f = function (cache, name, loc, v) {
    if (cache[name] !== v) { this.gl.uniform1f(loc, v); cache[name] = v; }
  };
  Engine.prototype._setU1i = function (cache, name, loc, v) {
    if (cache[name] !== v) { this.gl.uniform1i(loc, v); cache[name] = v; }
  };
  Engine.prototype._setU2f = function (cache, name, loc, x, y) {
    var nx = name + 'x', ny = name + 'y';
    if (cache[nx] === x && cache[ny] === y) return;
    this.gl.uniform2f(loc, x, y);
    cache[nx] = x; cache[ny] = y;
  };
  Engine.prototype._setU4f = function (cache, name, loc, a, b, c, d) {
    var na = name + 'a', nb = name + 'b', nc = name + 'c', nd = name + 'd';
    if (cache[na] === a && cache[nb] === b && cache[nc] === c && cache[nd] === d) return;
    this.gl.uniform4f(loc, a, b, c, d);
    cache[na] = a; cache[nb] = b; cache[nc] = c; cache[nd] = d;
  };
  Engine.prototype._setU4fv = function (cache, name, loc, arr) {
    var na = name + 'a', nb = name + 'b', nc = name + 'c', nd = name + 'd';
    if (cache[na] === arr[0] && cache[nb] === arr[1] && cache[nc] === arr[2] && cache[nd] === arr[3]) return;
    this.gl.uniform4fv(loc, arr);
    cache[na] = arr[0]; cache[nb] = arr[1]; cache[nc] = arr[2]; cache[nd] = arr[3];
  };

  Engine.prototype.drawElement = function (cfg) {
    var gl = this.gl;
    var L = this.elemLoc;
    var dpr = this.dpr;
    var C = this._elUniformCache;
    gl.useProgram(this.elemProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(L.aPos);
    gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cfg.backdropTex || this.fboATex);
    this._setU1i(C, 'backdrop', L.uBackdrop, 0);
    if (this.wallpaperTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTex);
      this._setU1i(C, 'wpSampler', L.uWallpaperSampler, 1);
    }

    var cw = this.canvas.width, ch = this.canvas.height;
    this._setU2f(C, 'canvasSize', L.uCanvasSize, cw, ch);
    this._setU2f(C, 'wpSize', L.uWallpaperSize, this.wallpaperSize[0], this.wallpaperSize[1]);

    var vw = Math.max(1, window.innerWidth * dpr);
    var vh = Math.max(1, window.innerHeight * dpr);
    this._setU2f(C, 'viewport', L.uViewportSize, vw, vh);
    this._setU2f(C, 'navOff', L.uNavOffset, (this.navLeft || 0) * dpr, (this.navTop || 0) * dpr);

    var ex = cfg.x * dpr, ey = cfg.y * dpr, ew = cfg.w * dpr, eh = cfg.h * dpr;
    this._setU2f(C, 'elOff', L.uElementOffset, ex, ey);
    this._setU2f(C, 'elSize', L.uElementSize, ew, eh);

    var cr = cfg.cornerRadius * dpr;
    this._setU4f(C, 'radii', L.uCornerRadii, cr, cr, cr, cr);

    var os = cfg.originalSize || [cfg.w, cfg.h];
    this._setU2f(C, 'origSize', L.uOriginalSize, os[0] * dpr, os[1] * dpr);
    this._setU1f(C, 'origCR', L.uOriginalCornerRadius, cr);
    this._setU2f(C, 'layerScale', L.uLayerScale, cfg.layerScaleX, cfg.layerScaleY);
    this._setU1f(C, 'refrH', L.uRefractionHeight, cfg.refractionHeight * dpr);
    this._setU1f(C, 'refrA', L.uRefractionAmount, cfg.refractionAmount * dpr);
    this._setU1f(C, 'depth', L.uDepthEffect, cfg.depthEffect ? 1 : 0);
    this._setU1f(C, 'chroma', L.uChromaticAberration, cfg.chromaticAberration ? 1 : 0);
    this._setU1f(C, 'blur', L.uBlurRadius, cfg.blurRadius * dpr);
    this._setU1f(C, 'sat', L.uSaturation, cfg.saturation);
    this._setU1f(C, 'bright', L.uBrightness, cfg.brightness);
    this._setU1f(C, 'contrast', L.uContrast, cfg.contrast);
    this._setU4fv(C, 'tint', L.uTintColor, cfg.tint);
    this._setU4f(C, 'surface', L.uSurfaceColor, cfg.surface[0], cfg.surface[1], cfg.surface[2], cfg.surface[3]);
    this._setU4f(C, 'scrim', L.uScrimColor, 0, 0, 0, 0);
    this._setU1f(C, 'sampleWP', L.uSampleWallpaper, cfg.sampleWallpaper ? 1 : 0);

    var dim = cfg.dim || [0, 0, 0, 0];
    var dimA = cfg.dimMulByPress ? dim[3] * this.press.p : dim[3];
    this._setU4f(C, 'dim', L.uDimOverlay, dim[0], dim[1], dim[2], dimA);
    this._setU1f(C, 'pressDark', L.uPressDarken, cfg.pressDarken || 0);

    var opacity;
    if (cfg.opacity != null) {
      opacity = cfg.opacity;
    } else {
      opacity = cfg.surface[3];
      if (cfg.dimMulByPress && dimA > opacity) opacity = dimA;
    }
    this._setU1f(C, 'opacity', L.uOpacity, opacity);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  Engine.prototype.drawRim = function (cfg) {
    var gl = this.gl;
    var L = this.rimLoc;
    var dpr = this.dpr;
    var C = this._rimUniformCache;
    gl.useProgram(this.rimProgram);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(L.aPos);
    gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);

    this._setU2f(C, 'canvasSize', L.uCanvasSize, this.canvas.width, this.canvas.height);
    this._setU2f(C, 'offset', L.uOffset, cfg.x * dpr, cfg.y * dpr);
    this._setU2f(C, 'size', L.uSize, cfg.w * dpr, cfg.h * dpr);
    this._setU4f(C, 'hlColor', L.uHighlightColor, 1, 1, 1, 1);
    this._setU1f(C, 'hlAngle', L.uHighlightAngle, 45 * Math.PI / 180);
    this._setU1f(C, 'hlFall', L.uHighlightFalloff, 1.0);
    this._setU1f(C, 'hlAlpha', L.uHighlightAlpha, cfg.alpha);
    this._setU1f(C, 'hlStroke', L.uHighlightStrokeWidth, cfg.strokeWidth);
    this._setU1f(C, 'hlBlur', L.uHighlightBlur, cfg.blurSigma);
    var os = cfg.originalSize;
    this._setU2f(C, 'origSize', L.uOriginalSize, os[0] * dpr, os[1] * dpr);
    this._setU1f(C, 'origCR', L.uOriginalCornerRadius, cfg.cornerRadius * dpr);
    this._setU2f(C, 'layerScale', L.uLayerScale, cfg.layerScaleX, cfg.layerScaleY);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  /* ---------------- 销毁 ---------------------------------------- */
  Engine.prototype.destroy = function () {
    this.destroyed = true;
    window.removeEventListener('resize', this._onResize);
    if (this._onNavPointerDown) this.nav.removeEventListener('pointerdown', this._onNavPointerDown);
    if (this._onPointerMove) window.removeEventListener('pointermove', this._onPointerMove);
    if (this._onPointerUp) {
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
    }
    if (this.ro) this.ro.disconnect();
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  /* ---------------- 公共 API ------------------------------------ */
  window.LiquidGlass = {
    /**
     * 初始化液态玻璃导航栏。
     * @param {{nav:string|Element, order:string[], onSelect:Function}} options
     */
    init: function (options) {
      var opt = typeof options === 'string' ? { nav: options } : (options || {});
      var navEl = typeof opt.nav === 'string' ? document.querySelector(opt.nav) : opt.nav;
      if (!navEl || !document.querySelector('.bottom-nav .nav-item')) return null;
      if (engine) { engine.destroy(); engine = null; }
      engine = new Engine(navEl, opt);
      // 初始视图同步（hash 启动定位）
      var initial = location.hash.slice(1);
      var idx = engine.order.indexOf(initial);
      engine.targetFraction = engine.fraction = idx >= 0 ? idx : 0;
      engine.invalidate();
      return engine;
    },
    /** 同步激活的 tab（名称）。common.js 在 switchView 中调用。 */
    setActiveTab: function (name) {
      if (!engine || !engine.ready) return;
      var idx = engine.order.indexOf(name);
      if (idx >= 0) engine.setTabByIndex(idx);
    },
    /** 强制立即刷新布局与画面。 */
    refresh: function () {
      if (!engine || !engine.ready) return;
      engine.layoutDirty = true;
      engine.invalidate();
    },
    _engine: function () { return engine; },

    /**
     * 为任意元素创建独立的液态玻璃胶囊（无指示器，纯静态玻璃效果）。
     * @param {string|Element} el 元素或选择器
     */
    createGlass: function (el) {
      var target = typeof el === 'string' ? document.querySelector(el) : el;
      if (!target) return null;
      return new GlassPill(target);
    }
  };

  /* ================================================================
   * GlassPill — 独立玻璃胶囊（用于赛季选择框等非导航元素）
   * 复用 Engine 的着色器与壁纸采样，渲染静态磨砂玻璃胶囊
   * ================================================================ */
  function GlassPill(el) {
    this.el = el;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.destroyed = false;

    // Canvas 注入
    var canvas = document.createElement('canvas');
    canvas.className = 'nav-glass-canvas';
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:0;';
    el.insertBefore(canvas, el.firstChild);
    this.canvas = canvas;

    // 确保元素子元素在玻璃之上
    for (var n = el.firstElementChild; n; n = n.nextElementSibling) {
      if (n !== canvas && getComputedStyle(n).position === 'static') {
        n.style.position = 'relative';
        n.style.zIndex = '2';
      }
    }

    var glAttrs = { alpha: true, premultipliedAlpha: false, antialias: true, depth: false, stencil: false };
    var gl = canvas.getContext('webgl', glAttrs) || canvas.getContext('experimental-webgl', glAttrs);
    if (!gl) { return null; }
    this.gl = gl;

    // 着色器
    var elFs = buildElementFS();
    var rimFs = buildRimFS();
    try {
      this.elemProgram = this._createProgram(VERT_SRC, elFs);
      this.rimProgram = this._createProgram(VERT_SRC, rimFs);
    } catch (e) { return null; }
    this.elemLoc = this._collectUniforms(this.elemProgram, ['aPos','uBackdrop','uWallpaperSampler','uCanvasSize','uWallpaperSize',
      'uElementOffset','uElementSize','uCornerRadii','uOriginalSize','uOriginalCornerRadius',
      'uLayerScale','uRefractionHeight','uRefractionAmount','uDepthEffect','uChromaticAberration',
      'uBlurRadius','uSaturation','uBrightness','uContrast','uTintColor','uSurfaceColor',
      'uScrimColor','uSampleWallpaper','uDimOverlay','uPressDarken','uViewportSize','uNavOffset','uOpacity']);
    this.rimLoc = this._collectUniforms(this.rimProgram, ['aPos','uCanvasSize','uOffset','uSize',
      'uHighlightColor','uHighlightAngle','uHighlightFalloff','uHighlightAlpha',
      'uHighlightStrokeWidth','uHighlightBlur','uOriginalSize','uOriginalCornerRadius','uLayerScale']);
    this.copyProgram = this._createProgram(VERT_SRC,
      'precision highp float;' +
      'uniform sampler2D uTexture;' +
      'uniform vec2 uTexSize;' +
      'uniform float uAlpha;' +
      'varying vec2 vUv;' +
      'void main(){ gl_FragColor = texture2D(uTexture, vUv) * uAlpha; }');
    this.copyLoc = this._collectUniforms(this.copyProgram, ['aPos','uTexture','uTexSize','uAlpha']);

    // 全屏四边形
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);

    // FBO
    this.fboW = 1; this.fboH = 1;
    this.fboA = gl.createFramebuffer();
    this.fboB = gl.createFramebuffer();
    this.fboATex = gl.createTexture();
    this.fboBTex = gl.createTexture();
    this._initFBO(this.fboA, this.fboATex);
    this._initFBO(this.fboB, this.fboBTex);

    // 壁纸
    this._wallpaperTex = null;
    this._wallpaperSize = [1920, 1080];
    this._useProcedural = false;
    this._proceduralSeed = Math.random() * 1000;
    this._isLight = true;
    this._glassAlpha = 0.92;

    // 加载壁纸（复用 Engine 的逻辑）
    this._loadWallpaper();

    // 初始测量
    this._measure();
    this._render();

    // 监听尺寸变化
    var self = this;
    this._ro = new ResizeObserver(function () {
      self._measure();
      self._render();
    });
    this._ro.observe(el);
    window.addEventListener('resize', function () { self._measure(); self._render(); });
  }

  GlassPill.prototype._createProgram = function (vs, fs) {
    var gl = this.gl;
    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  };
  GlassPill.prototype._collectUniforms = function (prog, names) {
    var gl = this.gl;
    var locs = {};
    for (var i = 0; i < names.length; i++) {
      locs[names[i]] = gl.getUniformLocation(prog, names[i]);
    }
    return locs;
  };
  GlassPill.prototype._initFBO = function (fbo, tex) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  GlassPill.prototype._loadWallpaper = function () {
    var self = this;
    var gl = this.gl;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    var src = this._isLight ? 'OP2Day.png' : 'OP2Night.png';
    img.onload = function () {
      gl.bindTexture(gl.TEXTURE_2D, self._wallpaperTex = gl.createTexture());
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      self._wallpaperSize = [img.naturalWidth, img.naturalHeight];
      self._useProcedural = false;
      self._measure();
      self._render();
    };
    img.onerror = function () {
      self._useProcedural = true;
      self._measure();
      self._render();
    };
    img.src = src;
  };
  GlassPill.prototype._measure = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = this.dpr;
    var cw = Math.max(1, Math.round(rect.width * dpr));
    var ch = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    this.canvas.style.height = (ch / dpr) + 'px';
    this._cw = cw; this._ch = ch;
    // 重新分配 FBO
    this.fboW = cw; this.fboH = ch;
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
    gl.bindTexture(gl.TEXTURE_2D, this.fboATex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.bindTexture(gl.TEXTURE_2D, this.fboBTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  GlassPill.prototype._render = function () {
    if (this.destroyed) return;
    var gl = this.gl;
    var cw = this._cw, ch = this._ch;
    if (!cw || !ch) return;

    // Pass 1: 玻璃胶囊 → fboB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.viewport(0, 0, this.fboW, this.fboH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);

    var dpr = this.dpr;
    var pad = 8 * dpr;
    var w = cw - pad * 2;
    var h = ch - pad * 2;
    var x = pad;
    var y = pad;
    var r = h / 2;

    gl.useProgram(this.elemProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.elemLoc.aPos);
    gl.vertexAttribPointer(this.elemLoc.aPos, 2, gl.FLOAT, false, 0, 0);

    // 壁纸纹理
    if (this._wallpaperTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._wallpaperTex);
      gl.uniform1i(this.elemLoc.uWallpaperSampler, 0);
      gl.uniform1f(this.elemLoc.uSampleWallpaper, 1);
    } else {
      gl.uniform1f(this.elemLoc.uSampleWallpaper, 0);
    }
    gl.uniform2f(this.elemLoc.uCanvasSize, cw, ch);
    gl.uniform2f(this.elemLoc.uViewportSize, cw, ch);
    gl.uniform2f(this.elemLoc.uWallpaperSize, this._wallpaperSize[0], this._wallpaperSize[1]);
    gl.uniform2f(this.elemLoc.uNavOffset, 0, 0);
    gl.uniform2f(this.elemLoc.uElementOffset, x, y);
    gl.uniform2f(this.elemLoc.uElementSize, w, h);
    gl.uniform2f(this.elemLoc.uCornerRadii, r, r);
    gl.uniform2f(this.elemLoc.uOriginalSize, w, h);
    gl.uniform1f(this.elemLoc.uOriginalCornerRadius, r);
    gl.uniform2f(this.elemLoc.uLayerScale, 1, 1);
    gl.uniform1f(this.elemLoc.uRefractionHeight, 24);
    gl.uniform1f(this.elemLoc.uRefractionAmount, -24);
    gl.uniform1f(this.elemLoc.uBlurRadius, 16);
    gl.uniform1f(this.elemLoc.uSaturation, 1.5);
    gl.uniform1f(this.elemLoc.uBrightness, 0);
    gl.uniform1f(this.elemLoc.uContrast, 1);
    gl.uniform1f(this.elemLoc.uDepthEffect, 1);
    gl.uniform1f(this.elemLoc.uChromaticAberration, 0);
    gl.uniform4f(this.elemLoc.uTintColor, 0, 0, 0, 0);
    gl.uniform4f(this.elemLoc.uSurfaceColor, 0.98, 0.98, 0.98, 0.80);
    gl.uniform4f(this.elemLoc.uScrimColor, 0, 0, 0, 0);
    gl.uniform4f(this.elemLoc.uDimOverlay, 0, 0, 0, 0);
    gl.uniform1f(this.elemLoc.uPressDarken, 0);
    gl.uniform1f(this.elemLoc.uOpacity, 1);
    gl.uniform1i(this.elemLoc.uBackdrop, 0);

    // 传递纹理（占位）
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboATex);
    gl.uniform1i(this.elemLoc.uBackdrop, 1);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 边缘高光
    gl.useProgram(this.rimProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.rimLoc.aPos);
    gl.vertexAttribPointer(this.rimLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.rimLoc.uCanvasSize, cw, ch);
    gl.uniform2f(this.rimLoc.uOffset, x, y);
    gl.uniform2f(this.rimLoc.uSize, w, h);
    gl.uniform4f(this.rimLoc.uHighlightColor, 1, 1, 1, 1);
    gl.uniform1f(this.rimLoc.uHighlightAngle, 135 * Math.PI / 180);
    gl.uniform1f(this.rimLoc.uHighlightFalloff, 3);
    gl.uniform1f(this.rimLoc.uHighlightAlpha, 0.5);
    gl.uniform1f(this.rimLoc.uHighlightStrokeWidth, 2);
    gl.uniform1f(this.rimLoc.uHighlightBlur, 6);
    gl.uniform2f(this.rimLoc.uOriginalSize, w, h);
    gl.uniform1f(this.rimLoc.uOriginalCornerRadius, r);
    gl.uniform2f(this.rimLoc.uLayerScale, 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Present: fboB → 屏幕
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.copyProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.copyLoc.aPos);
    gl.vertexAttribPointer(this.copyLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboBTex);
    gl.uniform1i(this.copyLoc.uTexture, 0);
    gl.uniform2f(this.copyLoc.uTexSize, this.fboW, this.fboH);
    gl.uniform1f(this.copyLoc.uAlpha, 0.92);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  GlassPill.prototype.destroy = function () {
    this.destroyed = true;
    if (this._ro) this._ro.disconnect();
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };
})();

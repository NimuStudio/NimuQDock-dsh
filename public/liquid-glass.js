// =============================================

//  Nimu Liquid Glass — WebGL2 v2 Enhanced

//  Mouse-reactive blobs, modal glass panels,

//  premium color palette, optimized rendering

// =============================================

(function(){

'use strict';



var LiquidGlass = {

  canvas: null, gl: null,

  shapes: [], time: 0, animId: null,

  bgColor: [0.85, 0.87, 0.92],

  dpr: 0, mouseX: 0.5, mouseY: 0.5, targetMX: 0.5, targetMY: 0.5,

  program: null, blurProgH: null, blurProgV: null,

  fbScene: null, texScene: null, fbBlur: null, texBlur: null,

  uLoc: {}, quadVao: null, inited: false,

  

  // Modal glass panel state

  modalActive: false, modalX: 0, modalY: 0, modalW: 0, modalH: 0,

  modalTargetX: 0, modalTargetY: 0, modalTargetW: 0, modalTargetH: 0,



  init: function(container) {

    if (this.inited) return true;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas = document.createElement('canvas');

    this.canvas.id = 'liquid-glass-bg';

    this.canvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';

    (container || document.body).prepend(this.canvas);

    this.gl = this.canvas.getContext('webgl2', {alpha:true,premultipliedAlpha:false,antialias:true,preserveDrawingBuffer:false});

    if (!this.gl) { console.warn('WebGL2 unavailable'); return false; }

    this.resize();

    this._initPrograms();

    this._initGeometry();

    this._initShapes();

    this._bindEvents();

    this.inited = true;

    this._loop = this._loop.bind(this);

    this._loop();

    window.addEventListener('resize', function() { LiquidGlass.resize(); });

    return true;

  },



  resize: function() {

    var gl = this.gl; if (!gl) return;

    var w = Math.floor(window.innerWidth * this.dpr);

    var h = Math.floor(window.innerHeight * this.dpr);

    this.canvas.width = w; this.canvas.height = h;

    this.canvas.style.width = window.innerWidth + 'px';

    this.canvas.style.height = window.innerHeight + 'px';

    gl.viewport(0, 0, w, h);

    this._resizeFBO(w, h);

  },



  // ---- Shader compilation ----

  _makeShader: function(type, src) {

    var gl = this.gl, s = gl.createShader(type);

    gl.shaderSource(s, src); gl.compileShader(s);

    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('Shader:', gl.getShaderInfoLog(s));

    return s;

  },

  _makeProgram: function(vsSrc, fsSrc) {

    var gl = this.gl, p = gl.createProgram();

    var vs = this._makeShader(gl.VERTEX_SHADER, vsSrc);

    var fs = this._makeShader(gl.FRAGMENT_SHADER, fsSrc);

    gl.attachShader(p, vs); gl.attachShader(p, fs);

    gl.linkProgram(p); gl.deleteShader(vs); gl.deleteShader(fs); return p;

  },



  _initPrograms: function() {

    var VS = '#version 300 es\nin vec2 aPos;out vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0,1);}';

    

    // Main glass shader — SDF superellipse blobs with Fresnel + glare

    var FS_MAIN = '#version 300 es\nprecision highp float;\n'+

      'in vec2 vUv;out vec4 fragColor;\n'+

      'uniform vec2 uRes;uniform float uTime;\n'+

      'uniform vec3 uPos[10];uniform vec2 uSize[10];\n'+

      'uniform float uRound[10];uniform vec3 uColor[10];\n'+

      'uniform float uBlur[10];uniform int uCount;\n'+

      'uniform vec4 uModal;uniform vec2 uLightPos;\n'+

      // SDF superellipse

      'float sdSuperellipse(vec2 p,vec2 r,float n){vec2 q=abs(p)/r;return pow(pow(q.x,n)+pow(q.y,n),1.0/n)-0.92;}\n'+

      'float sdRoundRect(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;}\n'+

      'void main(){\n'+

      '  vec2 uv=vUv;vec3 bg=vec3(0.84,0.86,0.94);\n'+
      // Ambient gradient

      '  float grad=mix(0.94,1.0,uv.y)*mix(0.95,1.0,uv.x*0.3+0.7);bg*=grad;\n'+

      // Dynamic light from mouse position

      '  vec2 lightUv=uLightPos;\n'+

      '  float lightDist=length(uv-lightUv)*2.5;\n'+

      '  float lightFalloff=exp(-lightDist*lightDist*1.8);\n'+

      '  vec3 lightColor=vec3(1.0,0.96,0.88);\n'+

      '  bg+=lightColor*lightFalloff*0.12;\n'+

      // Render blobs with enhanced lighting

      '  vec3 glassAccum=vec3(0);float totalAlpha=0.0;\n'+

      '  for(int i=0;i<10;i++){\n'+

      '    if(i>=uCount)break;\n'+

      '    vec2 center=(uPos[i].xy/uRes)*0.5+0.5;\n'+

      '    vec2 p=(uv-center)*uRes;\n'+

      '    float d=sdSuperellipse(p,uSize[i],uRound[i]);\n'+

      '    float blur=uBlur[i];\n'+

      '    float alpha=smoothstep(blur,0.0,d);\n'+

      '    float edge=smoothstep(blur*0.5,blur*0.2,d);\n'+

      '    vec3 col=uColor[i];\n'+

      // Enhanced Fresnel with chromatic dispersion

      '    float fresnel=pow(1.0-edge,1.5);\n'+

      '    vec3 fresnelCol=vec3(0.55,0.57,0.62)*fresnel;\n'+

      '    vec3 result=mix(col*1.1,col*0.8,fresnel);\n'+

      // Edge highlight — stronger and more defined

      '    float edgeGlow=1.0-smoothstep(blur*0.4,blur*0.05,d);\n'+

      '    result+=vec3(0.88,0.89,0.90)*edgeGlow*0.10;\n'+

      // Specular highlight from light source

      '    float spec=pow(1.0-smoothstep(blur*0.3,blur*0.0,d),6.0);\n'+

      '    float lightAngle=dot(normalize(p),normalize((lightUv-uv)*uRes))*0.5+0.5;\n'+

      '    float specHighlight=spec*pow(lightAngle,12.0)*0.35;\n'+

      '    result+=vec3(0.9,0.9,0.85)*specHighlight;\n'+

      // Chromatic fringe at edges (subtle color separation)

      '    float fringe=1.0-smoothstep(blur*0.2,blur*0.0,d);\n'+

      '    \n'+

      '    glassAccum=mix(glassAccum,result,alpha*0.04/(totalAlpha+0.04));\n'+

      '    totalAlpha=max(totalAlpha,alpha*0.18);\n'+

      '  }\n'+

      '  bg=mix(bg,glassAccum,totalAlpha);\n'+

      // Modal glass panel with specular highlight

      '  if(uModal.w>0.0){\n'+

      '    vec2 mc=(uModal.xy/uRes)*0.5+0.5;\n'+

      '    vec2 ms=uModal.zw*0.5;\n'+

      '    vec2 mp=(uv-mc)*uRes;\n'+

      '    float md=sdRoundRect(mp,ms,28.0);\n'+

      '    float ma=smoothstep(22.0,0.0,md);\n'+

      '    float me=smoothstep(18.0,8.0,md);\n'+

      '    vec3 modalCol=vec3(0.94,0.945,0.96);\n'+

      '    float mf=pow(1.0-me,2.8);\n'+

      '    modalCol=mix(modalCol*1.15,modalCol*0.65,mf);\n'+

      '    float modalEdge=1.0-smoothstep(16.0,22.0,md);\n'+

      '    modalCol+=vec3(0.55,0.57,0.63)*modalEdge*0.65;\n'+

      // Modal specular

      '    float mspec=pow(1.0-smoothstep(12.0,0.0,md),3.0);\n'+

      '    float mlight=dot(normalize(mp),normalize((lightUv-uv)*uRes))*0.5+0.5;\n'+

      '    modalCol+=vec3(0.85,0.85,0.8)*mspec*pow(mlight,8.0)*0.2;\n'+

      '    bg=mix(bg,modalCol,ma*0.35);\n'+

      '  }\n'+

      // Top-left glare — enhanced

      '  float glare=smoothstep(0.25,0.7,uv.y)*smoothstep(0.65,0.25,uv.x);\n'+

      '  bg+=vec3(0.05,0.055,0.065)*glare*0.4;\n'+

      // Secondary bounce light from bottom-right

      '  float bounce=smoothstep(0.7,0.3,uv.y)*smoothstep(0.3,0.75,uv.x);\n'+

      '  bg+=vec3(0.02,0.025,0.03)*bounce*0.2;\n'+

      // Subtle vignette

      '  float vig=1.0-smoothstep(0.5,1.5,length((uv-0.5)*1.4))*0.07;\n'+

      '  bg*=vig;\n'+

      '  fragColor=vec4(bg,1.0);\n'+

      '}';

this.program = this._makeProgram(VS, FS_MAIN);



    // Cache uniform locations

    var gl = this.gl, p = this.program;

    this.uLoc.res = gl.getUniformLocation(p, 'uRes');

    this.uLoc.time = gl.getUniformLocation(p, 'uTime');

    this.uLoc.count = gl.getUniformLocation(p, 'uCount');

    this.uLoc.modal = gl.getUniformLocation(p, 'uModal');

    this.uLoc.lightPos = gl.getUniformLocation(p, 'uLightPos');

    for (var i = 0; i < 10; i++) {

      this.uLoc['pos'+i] = gl.getUniformLocation(p, 'uPos['+i+']');

      this.uLoc['size'+i] = gl.getUniformLocation(p, 'uSize['+i+']');

      this.uLoc['round'+i] = gl.getUniformLocation(p, 'uRound['+i+']');

      this.uLoc['color'+i] = gl.getUniformLocation(p, 'uColor['+i+']');

      this.uLoc['blur'+i] = gl.getUniformLocation(p, 'uBlur['+i+']');

    }

  },



  _initGeometry: function() {

    var gl = this.gl;

    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);

    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);

    this.quadVao = gl.createVertexArray(); gl.bindVertexArray(this.quadVao);

    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);

  },



  _resizeFBO: function(w, h) {

    var gl = this.gl;

    function mkTex() {

      var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);

      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);

      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);

      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);

      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);

      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);

      return t;

    }

    if (this.texScene) { gl.deleteTexture(this.texScene); gl.deleteFramebuffer(this.fbScene); }

    if (this.texBlur) { gl.deleteTexture(this.texBlur); gl.deleteFramebuffer(this.fbBlur); }

    this.texScene = mkTex(); this.fbScene = gl.createFramebuffer();

    this.texBlur = mkTex(); this.fbBlur = gl.createFramebuffer();

  },



  // ---- Shapes ----

  _initShapes: function() {

    // Premium glass color palette — cool translucent tones

    var palette = [
      [0.48,0.62,0.92],[0.78,0.42,0.82],[0.38,0.68,0.82],
      [0.88,0.55,0.48],[0.45,0.70,0.85],[0.80,0.45,0.78],
      [0.42,0.65,0.90],[0.72,0.42,0.76],[0.42,0.75,0.70],
      [0.75,0.50,0.72],[0.44,0.68,0.88],[0.82,0.62,0.78]
    ]

    this.shapes = [];

    for (var i = 0; i < 10; i++) {

      var angle = (i / 10) * Math.PI * 2 + Math.random() * 0.5;

      var dist = 0.15 + Math.random() * 0.35;

      this.shapes.push({

        baseX: 0.5 + Math.cos(angle) * dist,

        baseY: 0.5 + Math.sin(angle) * dist,

        x: 0, y: 0, // computed each frame from base + mouse

        w: 280 + Math.random() * 450,

        h: 220 + Math.random() * 380,

        round: 3.5 + Math.random() * 5.0,

        blur: 35 + Math.random() * 50,

        color: palette[i % palette.length],

        phase: Math.random() * Math.PI * 2,

        amplitude: 0.003 + Math.random() * 0.006,

        mouseForce: 0.02 + Math.random() * 0.06

      });

    }

  },



  // ---- Modal glass panel API ----

  showModalGlass: function(el) {

    if (!el) { this.hideModalGlass(); return; }

    var rect = el.getBoundingClientRect();

    this.modalTargetX = rect.left + rect.width / 2;

    this.modalTargetY = rect.top + rect.height / 2;

    this.modalTargetW = rect.width / 2 + 40;

    this.modalTargetH = rect.height / 2 + 40;

    if (!this.modalActive) {

      this.modalX = this.modalTargetX;

      this.modalY = this.modalTargetY;

      this.modalW = 0; this.modalH = 0;

      this.modalActive = true;

    }

  },

  hideModalGlass: function() {

    this.modalActive = false;

    this.modalW = 0; this.modalH = 0;

  },

  _updateModalGlass: function() {

    if (!this.modalActive) {

      this.modalW += (0 - this.modalW) * 0.12;

      this.modalH += (0 - this.modalH) * 0.12;

      if (Math.abs(this.modalW) < 0.5) { this.modalW = 0; this.modalH = 0; }

      return;

    }

    var t = 0.18;

    this.modalX += (this.modalTargetX - this.modalX) * t;

    this.modalY += (this.modalTargetY - this.modalY) * t;

    this.modalW += (this.modalTargetW - this.modalW) * t;

    this.modalH += (this.modalTargetH - this.modalH) * t;

  },



  // ---- Events ----

  _bindEvents: function() {

    var self = this;

    document.addEventListener('mousemove', function(e) {

      self.targetMX = e.clientX / window.innerWidth;

      self.targetMY = e.clientY / window.innerHeight;

    }, {passive: true});

    // Modal glass is controlled via showModalGlass/hideModalGlass API

    // Called from the page's showModal/closeModal hooks

  },



  // ---- Render loop ----

  _loop: function() {

    this.time += 0.016;

    this.animId = requestAnimationFrame(this._loop);

    this._render();

  },



  _render: function() {

    var gl = this.gl; if (!gl) return;

    var w = this.canvas.width, h = this.canvas.height;

    

    // Smooth mouse lerp

    this.mouseX += (this.targetMX - this.mouseX) * 0.03;

    this.mouseY += (this.targetMY - this.mouseY) * 0.03;

    

    // Update shape positions (drift + mouse parallax)

    for (var i = 0; i < this.shapes.length; i++) {

      var s = this.shapes[i];

      var driftX = Math.sin(this.time * 0.4 + s.phase) * s.amplitude;

      var driftY = Math.cos(this.time * 0.35 + s.phase + 1.2) * s.amplitude;

      var mx = (this.mouseX - 0.5) * s.mouseForce;

      var my = (this.mouseY - 0.5) * s.mouseForce;

      s.x = s.baseX + driftX + mx;

      s.y = s.baseY + driftY + my;

      // Clamp to visible area with some margin

      s.x = Math.max(-0.15, Math.min(1.15, s.x));

      s.y = Math.max(-0.15, Math.min(1.15, s.y));

    }

    

    this._updateModalGlass();

    

    // Single render pass directly to screen (no FBO for performance)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.viewport(0, 0, w, h);

    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);

    

    gl.useProgram(this.program); gl.bindVertexArray(this.quadVao);

    gl.uniform2f(this.uLoc.res, w, h);

    gl.uniform1f(this.uLoc.time, this.time);

    gl.uniform1i(this.uLoc.count, this.shapes.length);

    gl.uniform4f(this.uLoc.modal, this.modalX, this.modalY, this.modalW, this.modalH);

    gl.uniform2f(this.uLoc.lightPos, this.mouseX, this.mouseY);

    

    for (var j = 0; j < 10; j++) {

      var sh = this.shapes[j] || this.shapes[0];

      gl.uniform3f(this.uLoc['pos'+j], sh.x * w, sh.y * h, 0);

      gl.uniform2f(this.uLoc['size'+j], sh.w, sh.h);

      gl.uniform1f(this.uLoc['round'+j], sh.round);

      gl.uniform3f(this.uLoc['color'+j], sh.color[0], sh.color[1], sh.color[2]);

      gl.uniform1f(this.uLoc['blur'+j], sh.blur);

    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  },



  destroy: function() {

    if (this.animId) cancelAnimationFrame(this.animId);

    if (this.canvas) this.canvas.remove();

    if (this.gl) {

      var gl = this.gl;

      gl.deleteProgram(this.program);

      [this.texScene,this.texBlur,this.fbScene,this.fbBlur].forEach(function(x) {

        if (x) { try { gl.deleteTexture(x); } catch(e){} try { gl.deleteFramebuffer(x); } catch(e){} }

      });

    }

    this.gl = null; this.inited = false;

  }

};



// Auto-init

if (document.readyState === 'loading') {

  document.addEventListener('DOMContentLoaded', function() { LiquidGlass.init(); });

} else { LiquidGlass.init(); }

window.LiquidGlass = LiquidGlass;

})();


/**
 * The volumetric cloudscape, shared by the app and the marketing page.
 *
 * A ray is marched per pixel through a density field confined between two
 * heights, with a second short march toward the sun for self-shadowing. Warm
 * where lit, cool indigo in shadow — that split is what reads as sunset rather
 * than as grey cloud tinted orange.
 *
 * Uniforms:
 *   uRes      viewport in device pixels
 *   uTime     seconds; drives cloud evolution
 *   uProg     0..1 scroll position; lifts the camera and raises the sun
 *   uPointer  -1..1 cursor; yaws and pitches the camera
 *   uDim      0..1 overall exposure. The app runs this well below the
 *             marketing page: behind a dense ledger the sky is atmosphere, not
 *             the subject, and every stop of brightness it gains is contrast
 *             the type loses.
 *
 * NOTE: site/index.html carries its own copy inline, because that page is
 * static HTML served without a bundler and cannot import this module. If the
 * shader changes here, change it there too.
 */
export const SKY_FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uProg;
uniform vec2 uPointer;
uniform float uDim;
float hash(vec3 p){ p = fract(p*0.3183099+vec3(0.71,0.113,0.419)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){
  vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){
  float v=0.0, a=0.5;
  for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.02; a*=0.5; }
  return v;
}
    /*
     * Density of the cloud slab.
     *
     * Confined between two heights so the marcher can skip everything outside
     * it, and eroded by a second, finer fbm — that erosion is what gives the
     * edges their wispiness instead of the cotton-wool look that a single
     * octave-stack always produces.
     */
float density(vec3 p){
  float h = (p.y - 1.2) / 2.6;
  if (h < 0.0 || h > 1.0) return 0.0;
  vec3 q = p + vec3(uTime*0.035, 0.0, uTime*0.012);
  float base = fbm(q*0.55);
  base = base - 0.44;
  base -= 0.16*fbm(q*2.3);
  float shape = smoothstep(0.0,0.28,h) * smoothstep(1.0,0.55,h);
  return clamp(base,0.0,1.0) * shape * 1.5;
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;
  float pr = clamp(uProg,0.0,1.0);
  vec3 ro = vec3(0.0, 0.55 + pr*0.55, uTime*0.06);
  float yaw = uPointer.x*0.10;
  float pitch = -0.06 + uPointer.y*0.05 + pr*0.16;
  vec3 rd = normalize(vec3(uv.x, uv.y + pitch, 1.25));
  float cy = cos(yaw), sy = sin(yaw);
  rd = vec3(rd.x*cy - rd.z*sy, rd.y, rd.x*sy + rd.z*cy);
  vec3 sunDir = normalize(vec3(0.36, -0.06 + pr*0.42, 1.0));
  float sunAmt = max(dot(rd, sunDir), 0.0);
  float horizon = smoothstep(-0.18, 0.42, rd.y);
  vec3 zenith = vec3(0.035,0.048,0.115);
  vec3 mid    = vec3(0.105,0.128,0.250);
  vec3 low    = vec3(0.315,0.238,0.272);
  vec3 ember  = vec3(0.560,0.350,0.245);
  vec3 sky = mix(ember, low, smoothstep(0.0,0.10,rd.y));
  sky = mix(sky, mid, smoothstep(0.05,0.34,rd.y));
  sky = mix(sky, zenith, smoothstep(0.28,0.85,rd.y));
  sky += vec3(1.0,0.74,0.46) * pow(sunAmt, 220.0) * 2.2;
  sky += vec3(1.0,0.62,0.36) * pow(sunAmt, 12.0) * 0.10 * (0.35+0.65*pr);
  vec3 col = sky;
  if (rd.y > -0.02) {
    float t = (1.2 - ro.y) / max(rd.y, 0.02);
    t = max(t, 0.0);
    float trans = 1.0;
    vec3 scattered = vec3(0.0);
    const int STEPS = 34;
    float stepLen = 0.16;
    for (int i = 0; i < STEPS; i++) {
      if (trans < 0.02) break;
      vec3 pos = ro + rd * t;
      if (pos.y > 3.9) break;
      float d = density(pos);
      if (d > 0.001) {
        float shadow = 0.0;
        const int LIGHT_STEPS = 4;
        for (int j = 1; j <= LIGHT_STEPS; j++) {
          shadow += density(pos + sunDir * (float(j)*0.16));
        }
        float light = exp(-shadow*0.72);
        vec3 lit  = mix(vec3(0.16,0.175,0.28), vec3(0.86,0.66,0.46), light);
        lit += vec3(1.0,0.58,0.30) * pow(sunAmt,10.0) * light * 0.30;
        float absorb = d * stepLen * 1.9;
        scattered += lit * absorb * trans;
        trans *= exp(-absorb*1.35);
      }
      t += stepLen * (1.0 + float(i)*0.035);
    }
    col = col * trans + scattered;
  }
  col = mix(col, ember*0.42, smoothstep(0.0,-0.22,rd.y));
  col *= 0.92 * uDim;
  col = col / (col + vec3(0.72));
  col = pow(col, vec3(0.92));
  col *= 1.0 - 0.36*dot(uv,uv);
  col += (hash(vec3(gl_FragCoord.xy, uTime))-0.5)*0.022;
  gl_FragColor = vec4(col, 1.0);
}
`;

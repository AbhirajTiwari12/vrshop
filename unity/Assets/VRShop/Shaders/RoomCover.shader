// Paints a real piece of furniture out of passthrough ("replace my couch"). Drawn on the back faces of the piece's
// (slightly inflated) box: for every pixel you see through the box, it traces the view ray to what's behind the piece —
// the floor, a wall or the ceiling — and draws that surface there, at that surface's true depth. So the couch
// disappears into "empty room", virtual furniture placed in its spot draws on top with correct depth, shadows land on
// the painted floor, and kept real furniture in front still hides it (their depth occluders render first).
// Quest 2 passthrough is black and white, so the tones are grays the user matches to their room in the headset.
// The edge fades with how much box the ray crosses, so the silhouette is soft instead of a hard cut-out.
Shader "VRShop/RoomCover"
{
    Properties
    {
        _FloorColor ("Floor tone", Color) = (0.4, 0.4, 0.4, 1)
        _WallColor ("Wall tone", Color) = (0.62, 0.62, 0.62, 1)
        _Opacity ("Opacity", Range(0, 1)) = 1
        _Feather ("Edge feather (m)", Float) = 0.06
        _Grain ("Grain", Range(0, 0.2)) = 0.03
    }
    SubShader
    {
        // After the depth occluders (Geometry-10), before virtual furniture (Geometry).
        Tags { "RenderType" = "Opaque" "Queue" = "Geometry-5" "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            Name "RoomCover"
            Tags { "LightMode" = "UniversalForward" }
            // Alpha goes to the eye buffer too: with passthrough underneath, alpha < 1 lets the real room show (fades).
            Blend SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha
            ZWrite On
            ZTest LEqual
            Cull Front

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            // Per-material (not SRP-batcher compatible because of the arrays; there are only a few pieces).
            half4 _FloorColor, _WallColor;
            half _Opacity, _Feather, _Grain;
            float4 _BoxCenter;   // xyz: box center (world)
            float4 _BoxAxisX;    // xyz: box right axis (unit)
            float4 _BoxAxisZ;    // xyz: box forward axis (unit)
            float4 _BoxHalf;     // xyz: half extents (inflated)
            float4 _Room;        // x: floor y, y: ceiling y, z: wall count
            float4 _WallA[8];    // xy: a point on the wall (xz), zw: normal into the room (xz)
            float4 _WallB[8];    // x: half width

            struct Attributes
            {
                float4 positionOS : POSITION;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings vert(Attributes input)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                VertexPositionInputs p = GetVertexPositionInputs(input.positionOS.xyz);
                o.positionCS = p.positionCS;
                o.positionWS = p.positionWS;
                return o;
            }

            float Hash12(float2 p)
            {
                float3 p3 = frac(float3(p.xyx) * 0.1031);
                p3 += dot(p3, p3.yzx + 33.33);
                return frac((p3.x + p3.y) * p3.z);
            }

            float ValueNoise(float2 p)
            {
                float2 i = floor(p), f = frac(p);
                float2 u = f * f * (3.0 - 2.0 * f);
                return lerp(lerp(Hash12(i), Hash12(i + float2(1, 0)), u.x), lerp(Hash12(i + float2(0, 1)), Hash12(i + float2(1, 1)), u.x), u.y);
            }

            half4 frag(Varyings i, out float outDepth : SV_Depth) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(i);
                float3 ro = GetCameraPositionWS();
                float3 rd = normalize(i.positionWS - ro);

                // Ray vs the box, in the box's frame (slab test). The camera may be inside it (tEnter = 0).
                float3 rel = ro - _BoxCenter.xyz;
                float3 lo = float3(dot(rel, _BoxAxisX.xyz), rel.y, dot(rel, _BoxAxisZ.xyz));
                float3 ld = float3(dot(rd, _BoxAxisX.xyz), rd.y, dot(rd, _BoxAxisZ.xyz));
                float3 safe = ld + 1e-6 * (step(0.0, ld) * 2.0 - 1.0);
                float3 inv = 1.0 / safe;
                float3 t0 = (-_BoxHalf.xyz - lo) * inv;
                float3 t1 = (_BoxHalf.xyz - lo) * inv;
                float3 tmin = min(t0, t1), tmax = max(t0, t1);
                float tEnter = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
                float tExit = min(min(tmax.x, tmax.y), tmax.z);
                clip(tExit - tEnter - 1e-4);

                // What's behind the piece: the nearest floor / ceiling / wall along the ray.
                float tBg = 1e4;
                int kind = 0;      // 0 floor, 1 wall, 2 ceiling
                int hitWall = 0;
                if (rd.y < -1e-4) { float t = (_Room.x - ro.y) / rd.y; if (t > 0 && t < tBg) { tBg = t; kind = 0; } }
                if (rd.y > 1e-4) { float t = (_Room.y - ro.y) / rd.y; if (t > 0 && t < tBg) { tBg = t; kind = 2; } }
                int wallCount = (int)_Room.z;
                for (int w = 0; w < 8; w++)
                {
                    float2 p = _WallA[w].xy, n = _WallA[w].zw;
                    float denom = dot(rd.xz, n);
                    // Only walls we're heading toward, hit in front of us, within the wall's ends.
                    if (w < wallCount && denom < -1e-4)
                    {
                        float t = dot(p - ro.xz, n) / denom;
                        float2 hit = ro.xz + rd.xz * t;
                        if (t > 0 && t < tBg && abs(dot(hit - p, float2(n.y, -n.x))) <= _WallB[w].x + 0.3)
                        {
                            tBg = t; kind = 1; hitWall = w;
                        }
                    }
                }
                float3 hitWS = ro + rd * tBg;

                // Tone + a little of the real room's shading: darker where floor meets wall, a soft band at the skirting.
                half3 col;
                float2 uv;
                if (kind == 0)
                {
                    float wallDist = 10.0;
                    for (int k = 0; k < 8; k++)
                    {
                        float2 d = hitWS.xz - _WallA[k].xy;
                        if (k < wallCount && abs(dot(d, float2(_WallA[k].w, -_WallA[k].z))) < _WallB[k].x + 0.05)
                            wallDist = min(wallDist, abs(dot(d, _WallA[k].zw)));
                    }
                    col = _FloorColor.rgb * lerp(0.82, 1.0, saturate(wallDist / 0.3));
                    uv = hitWS.xz;
                }
                else if (kind == 1)
                {
                    float h = hitWS.y - _Room.x;
                    col = _WallColor.rgb * lerp(0.86, 1.0, saturate(h / 0.25));
                    float2 n = _WallA[hitWall].zw;
                    uv = float2(dot(hitWS.xz - _WallA[hitWall].xy, float2(n.y, -n.x)), hitWS.y);
                }
                else
                {
                    col = _WallColor.rgb * 1.04;
                    uv = hitWS.xz;
                }
                // Fine grain in world space (passthrough is grainy; a perfectly flat patch reads as fake).
                float g = ValueNoise(uv * 70.0) * 0.6 + ValueNoise(uv * 11.0) * 0.4;
                col *= 1.0 + (g - 0.5) * 2.0 * _Grain;

                float alpha = _Opacity * smoothstep(0.0, max(_Feather, 1e-3), tExit - tEnter);

                float4 cs = TransformWorldToHClip(hitWS);
                float z = cs.z / cs.w;
                #if !UNITY_REVERSED_Z
                z = z * 0.5 + 0.5;
                #endif
                outDepth = z;
                return half4(col, alpha);
            }
            ENDHLSL
        }
    }
    FallBack Off
}

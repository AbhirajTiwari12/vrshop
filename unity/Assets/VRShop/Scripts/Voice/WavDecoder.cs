using System;
using System.Text;
using UnityEngine;

namespace VRShop.Voice
{
    /// <summary>
    /// 16-bit PCM WAV → AudioClip without a codec (the backend's speech endpoint always returns this format),
    /// so spoken replies behave the same in the Editor and on the Quest.
    /// </summary>
    public static class WavDecoder
    {
        public static AudioClip ToClip(byte[] wav, string name = "speech")
        {
            if (wav == null || wav.Length < 44 || Encoding.ASCII.GetString(wav, 0, 4) != "RIFF" || Encoding.ASCII.GetString(wav, 8, 4) != "WAVE")
                throw new FormatException("Not a WAV file");
            int channels = 1, rate = 24000, bits = 16, dataOff = -1, dataLen = 0;
            var pos = 12;
            while (pos + 8 <= wav.Length)
            {
                var id = Encoding.ASCII.GetString(wav, pos, 4);
                var size = BitConverter.ToInt32(wav, pos + 4);
                if (id == "fmt ")
                {
                    channels = BitConverter.ToInt16(wav, pos + 10);
                    rate = BitConverter.ToInt32(wav, pos + 12);
                    bits = BitConverter.ToInt16(wav, pos + 22);
                }
                else if (id == "data")
                {
                    dataOff = pos + 8;
                    dataLen = size < 0 ? wav.Length - dataOff : Math.Min(size, wav.Length - dataOff);
                    break;
                }
                pos += 8 + Math.Max(0, size) + (size & 1);
            }
            if (dataOff < 0 || bits != 16 || channels < 1) throw new FormatException($"Unsupported WAV ({bits}-bit, {channels} ch)");

            var samples = dataLen / 2;
            var data = new float[samples];
            for (var i = 0; i < samples; i++)
                data[i] = (short)(wav[dataOff + 2 * i] | (wav[dataOff + 2 * i + 1] << 8)) / 32768f;
            var clip = AudioClip.Create(name, samples / channels, channels, rate, false);
            clip.SetData(data, 0);
            return clip;
        }
    }
}

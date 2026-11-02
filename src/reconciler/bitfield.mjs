// Plain-JS port of src/utils/string/bitfield8.ts and
// src/utils/string/bitfield.ts (WatchedBitField), so the headless
// reconciler can parse Stremio's `state.watched` Cinemeta bitfield
// exactly the way the importer does. The watched set therefore reflects
// the episodes Stremio itself recorded — skipped episodes are not marked.

import pako from 'pako';

class BitField8 {
  constructor(size) {
    this.length = size;
    const byteLength = Math.ceil(size / 8);
    this.values = new Uint8Array(byteLength);
  }

  static fromPacked(compressed, length) {
    const inflated = pako.inflate(compressed);
    const bf = new BitField8(0);
    bf.values = inflated;
    bf.length = typeof length === 'number' ? length : inflated.length * 8;

    const requiredBytes = Math.ceil(bf.length / 8);
    if (requiredBytes > inflated.length) {
      const newValues = new Uint8Array(requiredBytes);
      for (let i = 0; i < inflated.length; i++) {
        newValues[i] = inflated[i];
      }
      bf.values = newValues;
    }
    return bf;
  }

  get(index) {
    if (index < 0 || index >= this.length) {
      throw new RangeError('Index out of bounds');
    }
    const byteIndex = index >> 3;
    const bit = index % 8;
    return (this.values[byteIndex] & (1 << bit)) !== 0;
  }

  set(index, value) {
    if (index < 0 || index >= this.length) {
      throw new RangeError('Index out of bounds');
    }
    const byteIndex = index >> 3;
    const bit = index % 8;
    const mask = 1 << bit;
    if (value) {
      this.values[byteIndex] |= mask;
    } else {
      this.values[byteIndex] &= ~mask;
    }
  }
}

export class WatchedBitField {
  constructor(bitfield, videoIds) {
    this.bitfield = bitfield;
    this.videoIds = videoIds;
  }

  static constructAndResize(serialized, videoIds) {
    const components = serialized.split(':');
    if (components.length < 3) {
      throw new Error('Invalid serialized format');
    }

    const serializedBuf = components.pop();
    const anchorLength = parseInt(components.pop(), 10);
    const anchorVideoId = components.join(':');
    const anchorVideoIdx = videoIds.indexOf(anchorVideoId);
    const offset = anchorLength - 1 - anchorVideoIdx;

    if (anchorVideoIdx === -1) {
      return new WatchedBitField(new BitField8(videoIds.length), videoIds);
    }

    // atob() in Node returns a binary string; pako wants bytes.
    const packedBytes = Uint8Array.from(atob(serializedBuf), (c) =>
      c.charCodeAt(0),
    );

    if (offset !== 0) {
      const prevBuf = BitField8.fromPacked(packedBytes, anchorLength);
      const resizedBitfield = new BitField8(videoIds.length);

      for (let i = 0; i < videoIds.length; i++) {
        const idxInPrev = i + offset;
        if (idxInPrev >= 0 && idxInPrev < prevBuf.length) {
          resizedBitfield.set(i, prevBuf.get(idxInPrev));
        }
      }
      return new WatchedBitField(resizedBitfield, videoIds);
    }

    const buf = BitField8.fromPacked(packedBytes, videoIds.length);
    return new WatchedBitField(buf, videoIds);
  }

  getVideo(videoId) {
    const idx = this.videoIds.indexOf(videoId);
    return idx !== -1 ? this.bitfield.get(idx) : false;
  }
}

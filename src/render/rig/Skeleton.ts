/**
 * Skeletons and pose resolution for the procedural character art.
 *
 * Rig-local space: origin at the feet, +x forward (the direction the character
 * faces), +y UP. Renderers flip y when they hand coordinates to canvas.
 *
 * Rotation is counter-clockwise in rig space, which gives two conventions that
 * every clip in Anim.ts relies on:
 *   - hanging bones (arms, legs, beard — rest rotation PI): +rot swings the tip
 *     FORWARD, toward +x.
 *   - upright bones (torso, chest, neck, head, hat — rest rotation 0): +rot tips
 *     the top BACKWARD, toward -x.
 */

import type { Bone, BoneName, Pose } from '@/core/types';

const PI = Math.PI;

export interface ResolvedBone {
  name: BoneName;
  x: number;
  y: number;
  rot: number;
  scale: number;
}

/**
 * Squat and wide: about 46 units tall with a head near a third of that, stubby
 * thick limbs and a hip line barely above the knee of a grown human.
 */
export const DWARF_SKELETON: Bone[] = [
  { name: 'root', parent: null, x: 0, y: 0, length: 0, rot: 0 },
  { name: 'pelvis', parent: 'root', x: 0, y: 15, length: 8, rot: 0 },
  { name: 'torso', parent: 'pelvis', x: 0, y: 0, length: 8, rot: 0 },
  { name: 'chest', parent: 'torso', x: 0, y: 8, length: 7, rot: 0 },
  { name: 'neck', parent: 'chest', x: 0, y: 7, length: 2.5, rot: 0 },
  { name: 'head', parent: 'neck', x: 0, y: 2.5, length: 13, rot: 0 },
  { name: 'hat', parent: 'head', x: 0, y: 9.5, length: 13, rot: 0 },
  { name: 'beard', parent: 'head', x: 0.9, y: 1.6, length: 7.5, rot: PI },

  { name: 'armL_upper', parent: 'chest', x: -1.6, y: 5.4, length: 6.6, rot: PI - 0.2 },
  { name: 'armL_lower', parent: 'armL_upper', x: 0, y: 6.6, length: 6.2, rot: 0.22 },
  { name: 'handL', parent: 'armL_lower', x: 0, y: 6.2, length: 3.4, rot: 0 },
  { name: 'armR_upper', parent: 'chest', x: 1.6, y: 5.4, length: 6.6, rot: PI + 0.2 },
  { name: 'armR_lower', parent: 'armR_upper', x: 0, y: 6.6, length: 6.2, rot: -0.22 },
  { name: 'handR', parent: 'armR_lower', x: 0, y: 6.2, length: 3.4, rot: 0 },

  { name: 'legL_upper', parent: 'pelvis', x: -2.6, y: 0, length: 7.6, rot: PI - 0.05 },
  { name: 'legL_lower', parent: 'legL_upper', x: 0, y: 7.6, length: 5.6, rot: 0.05 },
  { name: 'footL', parent: 'legL_lower', x: 0, y: 5.6, length: 5, rot: PI / 2 },
  { name: 'legR_upper', parent: 'pelvis', x: 2.6, y: 0, length: 7.6, rot: PI + 0.05 },
  { name: 'legR_lower', parent: 'legR_upper', x: 0, y: 7.6, length: 5.6, rot: -0.05 },
  { name: 'footR', parent: 'legR_lower', x: 0, y: 5.6, length: 5, rot: PI / 2 },
];

/** Tall and lean, ~72 units. Guards, interns, politicians, lobbyists. */
export const HUMAN_SKELETON: Bone[] = [
  { name: 'root', parent: null, x: 0, y: 0, length: 0, rot: 0 },
  { name: 'pelvis', parent: 'root', x: 0, y: 36, length: 12, rot: 0 },
  { name: 'torso', parent: 'pelvis', x: 0, y: 0, length: 12, rot: 0 },
  { name: 'chest', parent: 'torso', x: 0, y: 12, length: 11, rot: 0 },
  { name: 'neck', parent: 'chest', x: 0, y: 11, length: 4, rot: 0 },
  { name: 'head', parent: 'neck', x: 0, y: 4, length: 9, rot: 0 },
  { name: 'hat', parent: 'head', x: 0, y: 7, length: 8, rot: 0 },
  { name: 'beard', parent: 'head', x: 0.5, y: 0.9, length: 3.6, rot: PI },

  { name: 'armL_upper', parent: 'chest', x: -2.6, y: 9.4, length: 12.5, rot: PI - 0.1 },
  { name: 'armL_lower', parent: 'armL_upper', x: 0, y: 12.5, length: 11.5, rot: 0.12 },
  { name: 'handL', parent: 'armL_lower', x: 0, y: 11.5, length: 4, rot: 0 },
  { name: 'armR_upper', parent: 'chest', x: 2.6, y: 9.4, length: 12.5, rot: PI + 0.1 },
  { name: 'armR_lower', parent: 'armR_upper', x: 0, y: 12.5, length: 11.5, rot: -0.12 },
  { name: 'handR', parent: 'armR_lower', x: 0, y: 11.5, length: 4, rot: 0 },

  { name: 'legL_upper', parent: 'pelvis', x: -3.2, y: 0, length: 19, rot: PI - 0.03 },
  { name: 'legL_lower', parent: 'legL_upper', x: 0, y: 19, length: 15, rot: 0.03 },
  { name: 'footL', parent: 'legL_lower', x: 0, y: 15, length: 6, rot: PI / 2 },
  { name: 'legR_upper', parent: 'pelvis', x: 3.2, y: 0, length: 19, rot: PI + 0.03 },
  { name: 'legR_lower', parent: 'legR_upper', x: 0, y: 19, length: 15, rot: -0.03 },
  { name: 'footR', parent: 'legR_lower', x: 0, y: 15, length: 6, rot: PI / 2 },
];

const IDENTITY: ResolvedBone = { name: 'root', x: 0, y: 0, rot: 0, scale: 1 };

/**
 * Applies a pose to a skeleton and resolves every bone into rig-local space.
 * Bones may appear in the array in any order; parents are resolved first via a
 * name lookup, and a bone whose parent is missing is treated as a root.
 */
export function resolvePose(
  skeleton: Bone[],
  pose: Pose,
  scale: number,
): Map<BoneName, ResolvedBone> {
  const byName = new Map<BoneName, Bone>();
  for (const b of skeleton) byName.set(b.name, b);

  const out = new Map<BoneName, ResolvedBone>();
  const visiting = new Set<BoneName>();

  const resolve = (bone: Bone): ResolvedBone => {
    const done = out.get(bone.name);
    if (done) return done;

    let parent = IDENTITY;
    let parentScale = scale;
    if (bone.parent !== null && !visiting.has(bone.name)) {
      const pb = byName.get(bone.parent);
      if (pb && pb.name !== bone.name) {
        visiting.add(bone.name);
        parent = resolve(pb);
        parentScale = parent.scale;
        visiting.delete(bone.name);
      }
    }

    const bp = pose[bone.name];
    const ox = (bone.x + (bp?.x ?? 0)) * parentScale;
    const oy = (bone.y + (bp?.y ?? 0)) * parentScale;
    const c = Math.cos(parent.rot);
    const s = Math.sin(parent.rot);

    const r: ResolvedBone = {
      name: bone.name,
      x: parent.x + ox * c - oy * s,
      y: parent.y + ox * s + oy * c,
      rot: parent.rot + bone.rot + (bp?.rot ?? 0),
      scale: parentScale * (bp?.scale ?? 1),
    };
    out.set(bone.name, r);
    return r;
  };

  for (const b of skeleton) resolve(b);
  return out;
}

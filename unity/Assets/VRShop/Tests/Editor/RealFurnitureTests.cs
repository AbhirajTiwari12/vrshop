using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using VRShop.Interaction;
using VRShop.Room;

namespace VRShop.Tests
{
    /// <summary>Kept real furniture is solid; replacements stand in the old piece's spot. Pure math, no scene.</summary>
    public class RealFurnitureTests
    {
        // 4 m x 5 m room: x in [-2, 2], z in [0, 5]; normals point into the room.
        static readonly List<WallInfo> k_Walls = new List<WallInfo>
        {
            new WallInfo { center = new Vector3(0, 1.25f, 0), normal = Vector3.forward, width = 4, height = 2.5f },
            new WallInfo { center = new Vector3(0, 1.25f, 5), normal = Vector3.back, width = 4, height = 2.5f },
            new WallInfo { center = new Vector3(-2, 1.25f, 2.5f), normal = Vector3.right, width = 5, height = 2.5f },
            new WallInfo { center = new Vector3(2, 1.25f, 2.5f), normal = Vector3.left, width = 5, height = 2.5f },
        };
        static readonly Vector3 k_Centroid = new Vector3(0, 0, 2.5f);

        static List<WallPlane> Planes()
        {
            var list = new List<WallPlane>();
            foreach (var w in k_Walls) list.Add(new WallPlane(w.center, w.normal, w.width));
            return list;
        }

        // A couch against the z=0 wall: 2 m wide, 0.9 m deep, centered at (0, 0.5).
        static readonly Obb k_Couch = new Obb(new Vector3(0, 0, 0.5f), 1.0f, 0.45f, 0);
        static readonly Obb k_Chair = new Obb(Vector3.zero, 0.4f, 0.4f, 0);

        [Test]
        public void Penetration_PushesOutAlongTheShortestAxis()
        {
            var chair = k_Chair.At(new Vector2(0.2f, 1.2f)); // front 0.8, couch front 0.95 → 15 cm in
            Assert.IsTrue(chair.Penetration(k_Couch, out var push));
            Assert.AreEqual(0f, push.x, 1e-4f);
            Assert.AreEqual(0.15f, push.y, 1e-4f);
            Assert.IsFalse(k_Chair.At(new Vector2(0, 2)).Penetration(k_Couch, out _));
        }

        [Test]
        public void Resolve_MovesAnItemOutOfTheCouchAndInsideTheWalls()
        {
            var p = FootprintSolver.Resolve(new Vector3(0.2f, 0, 1.2f), k_Chair, new List<Obb> { k_Couch }, Planes());
            Assert.IsFalse(k_Chair.At(new Vector2(p.x, p.z)).Overlaps(k_Couch, 0.005f));
            Assert.Greater(p.z, 1.34f);
            var q = FootprintSolver.Resolve(new Vector3(1.9f, 0, 3f), k_Chair, new List<Obb>(), Planes());
            Assert.LessOrEqual(q.x, 2f - 0.4f + 1e-3f, "pushed back inside the x=2 wall");
        }

        [Test]
        public void Sweep_StopsAtTheCouchInsteadOfTunnellingThrough()
        {
            // Drag from in front of the couch to a point behind its middle.
            var p = FootprintSolver.Sweep(new Vector3(0, 0, 2f), new Vector3(0, 0, 0.3f), k_Chair, new List<Obb> { k_Couch }, Planes());
            Assert.Greater(p.z, 1.34f, $"stopped at the couch front (z={p.z})");
        }

        [Test]
        public void Sweep_SlidesAlongTheCouch()
        {
            // Diagonal drag into the couch keeps the sideways part of the motion.
            var p = FootprintSolver.Sweep(new Vector3(-0.5f, 0, 1.5f), new Vector3(0.5f, 0, 1.0f), k_Chair, new List<Obb> { k_Couch }, Planes());
            Assert.AreEqual(0.5f, p.x, 0.05f);
            Assert.Greater(p.z, 1.34f);
        }

        [Test]
        public void FreeSpot_IsTheNearestSpotOutsideRealFurniture()
        {
            Assert.IsTrue(FootprintSolver.TryFindFreeSpot(new Vector3(0, 0, 0.6f), k_Chair, new List<Obb> { k_Couch }, Planes(), null, out var spot));
            Assert.IsFalse(k_Chair.At(new Vector2(spot.x, spot.z)).Overlaps(k_Couch, 0.005f));
            Assert.Less(Vector3.Distance(spot, new Vector3(0, 0, 0.6f)), 1.3f);
            Assert.IsTrue(FootprintSolver.IsFree(k_Chair.At(new Vector2(spot.x, spot.z)), new List<Obb> { k_Couch }, Planes()));
        }

        [Test]
        public void ReplacementPose_BacksOntoTheSameWallFacingTheRoom()
        {
            var pose = ReplacementPose.For(new Vector3(0.3f, 0.425f, 0.5f), new Vector3(2f, 0.85f, 0.9f), 0, 2.2f, 0.95f, k_Walls, 0, k_Centroid);
            Assert.IsTrue(pose.againstWall);
            Assert.AreEqual(0f, pose.yawDeg, 0.01f);
            Assert.AreEqual(0.05f + 0.95f / 2, pose.position.z, 1e-4f);
            Assert.AreEqual(0.3f, pose.position.x, 1e-4f);
        }

        [Test]
        public void ReplacementPose_HandlesABoxDrawnFacingTheWall()
        {
            var pose = ReplacementPose.For(new Vector3(0, 0.425f, 0.5f), new Vector3(2f, 0.85f, 0.9f), 180, 2f, 0.9f, k_Walls, 0, k_Centroid);
            Assert.AreEqual(0f, pose.yawDeg, 0.01f);
            Assert.AreEqual(0.5f, pose.position.z, 1e-4f);
        }

        [Test]
        public void ReplacementPose_RunsAlongTheLongSideOfASidewaysBox()
        {
            var pose = ReplacementPose.For(new Vector3(-1.5f, 0.425f, 2.5f), new Vector3(0.9f, 0.85f, 2f), 0, 2f, 0.9f, k_Walls, 0, k_Centroid);
            Assert.AreEqual(90f, pose.yawDeg, 0.01f);
            Assert.AreEqual(-1.5f, pose.position.x, 1e-4f);
        }

        [Test]
        public void ReplacementPose_CentersAFreestandingPieceAndKeepsRaisedOnesUp()
        {
            var table = ReplacementPose.For(new Vector3(0, 0.225f, 3.6f), new Vector3(1.1f, 0.45f, 0.6f), 0, 1f, 0.5f, k_Walls, 0, k_Centroid);
            Assert.IsFalse(table.againstWall);
            Assert.AreEqual(3.6f, table.position.z, 1e-4f);
            Assert.AreEqual(180f, table.yawDeg, 0.01f);
            var lamp = ReplacementPose.For(new Vector3(1, 1.0f, 3), new Vector3(0.3f, 0.5f, 0.3f), 0, 0.3f, 0.3f, k_Walls, 0, k_Centroid);
            Assert.AreEqual(0.75f, lamp.position.y, 1e-4f);
        }
    }
}

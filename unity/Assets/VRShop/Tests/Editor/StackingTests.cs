using NUnit.Framework;
using UnityEngine;
using VRShop.Api;
using VRShop.Furniture;
using VRShop.Interaction;

namespace VRShop.Tests
{
    /// <summary>Lamps and small plants go on flat tops and stay within their edges.</summary>
    public class StackingTests
    {
        static readonly Dims k_Lamp = new Dims { w = 0.3f, d = 0.3f, h = 0.5f };
        static readonly Dims k_SmallPlant = new Dims { w = 0.3f, d = 0.3f, h = 0.6f };
        static readonly Dims k_Tree = new Dims { w = 0.5f, d = 0.5f, h = 1.5f };

        [Test]
        public void OnlyLampsAndSmallPlantsStack()
        {
            Assert.IsTrue(StackRules.IsStackable("table_lamp", k_Lamp));
            Assert.IsTrue(StackRules.IsStackable("plant", k_SmallPlant));
            Assert.IsFalse(StackRules.IsStackable("plant", k_Tree));
            Assert.IsFalse(StackRules.IsStackable("floor_lamp", k_Lamp));
            Assert.IsFalse(StackRules.IsStackable("side_table", k_Lamp));
        }

        [Test]
        public void TopsAreFlatFurniture_NotSeats()
        {
            Assert.IsTrue(StackRules.IsTop("side_table"));
            Assert.IsTrue(StackRules.IsTop("dresser"));
            Assert.IsFalse(StackRules.IsTop("sofa"));
            Assert.IsFalse(StackRules.IsTop("bed"));
            Assert.IsTrue(StackRules.IsRealTop("TABLE"));
            Assert.IsTrue(StackRules.IsRealTop("STORAGE"));
            Assert.IsFalse(StackRules.IsRealTop("COUCH"));
            Assert.IsFalse(StackRules.IsRealTop("SCREEN"));
        }

        [Test]
        public void LampsStayOffBenchesAndTallShelves_PlantsDont()
        {
            Assert.IsTrue(StackRules.Allows("table_lamp", k_Lamp, "nightstand", 0.55f));
            Assert.IsFalse(StackRules.Allows("table_lamp", k_Lamp, "bench", 0.45f));
            Assert.IsFalse(StackRules.Allows("table_lamp", k_Lamp, null, 1.8f));
            Assert.IsTrue(StackRules.Allows("plant", k_SmallPlant, "bench", 0.45f));
            Assert.IsTrue(StackRules.Allows("plant", k_SmallPlant, null, 1.8f));
        }

        [Test]
        public void ClampKeepsTheWholeFootprintOnTheTop()
        {
            var top = new Obb(new Vector3(1, 0, 1), 0.3f, 0.25f, 0);       // 60 x 50 cm side table
            var lamp = new Obb(Vector3.zero, 0.15f, 0.15f, 0);
            Assert.IsTrue(StackRules.TryClampOnto(top, lamp, new Vector2(5, 5), out var c));
            Assert.AreEqual(1 + 0.3f - 0.15f - 0.015f, c.x, 1e-4f);
            Assert.AreEqual(1 + 0.25f - 0.15f - 0.015f, c.y, 1e-4f);
            Assert.IsTrue(StackRules.TryClampOnto(top, lamp, new Vector2(1.05f, 0.95f), out var inside));
            Assert.AreEqual(new Vector2(1.05f, 0.95f), inside, "a spot that fits is kept as is");
        }

        [Test]
        public void ClampAccountsForATurnedTopAndRejectsWhatDoesntFit()
        {
            var turned = new Obb(Vector3.zero, 0.6f, 0.2f, 90);             // 1.2 m x 0.4 m, long side along z
            var lamp = new Obb(Vector3.zero, 0.15f, 0.15f, 0);
            Assert.IsTrue(StackRules.TryClampOnto(turned, lamp, new Vector2(0, 5), out var c));
            Assert.AreEqual(0.6f - 0.15f - 0.015f, c.y, 1e-4f);
            Assert.AreEqual(0f, c.x, 1e-4f);
            var bigPlant = new Obb(Vector3.zero, 0.3f, 0.3f, 0);
            Assert.IsFalse(StackRules.TryClampOnto(turned, bigPlant, Vector2.zero, out _));
        }
    }
}

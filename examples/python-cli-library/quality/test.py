import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mill_python_fixture import allocate


class Allocation(unittest.TestCase):
    def test_bound(self):
        self.assertEqual(allocate(3, 5), 3)
        self.assertEqual(allocate(0, 5), 0)
        with self.assertRaises(ValueError):
            allocate(-1, 3)


unittest.main()

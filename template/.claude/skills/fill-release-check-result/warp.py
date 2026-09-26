# マウスカーソルを指定座標へ飛ばす (Dock やホバー効果を撮影に写さないため)
import ctypes, ctypes.util, sys
cg = ctypes.CDLL(ctypes.util.find_library('CoreGraphics'))
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
cg.CGWarpMouseCursorPosition.argtypes = [CGPoint]
cg.CGWarpMouseCursorPosition(CGPoint(float(sys.argv[1]), float(sys.argv[2])))

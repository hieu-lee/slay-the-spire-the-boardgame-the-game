"""Rigid prop placement with the painted gripping fingers in front."""
import math
import numpy as np
from PIL import Image, ImageDraw


def attach_weapon(body, weapon, pivot, grip, degrees, finger_radius=4, support_grip=None):
    # Source prop points left. Inverse affine mapping preserves its dimensions.
    a = math.radians(degrees-180)
    c, s = math.cos(a), math.sin(a)
    prop = weapon.transform(body.size, Image.Transform.AFFINE,
        (c,s,pivot[0]-c*grip[0]-s*grip[1],-s,c,pivot[1]+s*grip[0]-c*grip[1]), Image.Resampling.BICUBIC)
    frame = body.copy()
    frame.alpha_composite(prop)
    fingers = body.copy()
    mask = Image.new('L',body.size)
    x,y = grip
    ImageDraw.Draw(mask).ellipse((x-finger_radius,y-finger_radius,x+finger_radius,y+finger_radius),fill=255)
    if support_grip is not None:
        x,y = support_grip
        ImageDraw.Draw(mask).ellipse((x-finger_radius,y-finger_radius,x+finger_radius,y+finger_radius),fill=255)
    fingers.putalpha(Image.fromarray(np.minimum(np.array(body.getchannel('A')),np.array(mask))))
    frame.alpha_composite(fingers)
    return frame

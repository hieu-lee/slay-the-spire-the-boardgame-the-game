"""Offline RIFE 4.26 in-betweens, transporting native alpha with the same flow.

Use only between nearby audited body poses. Composite rigid weapons afterward.
The optional model checkout lives outside shipped assets; see README.md.
"""
import os
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image


@lru_cache(maxsize=1)
def model():
    import torch
    directory = Path(os.environ.get('RIFE_MODEL_DIR',
        str(Path(__file__).resolve().parents[2] / 'artifacts/choreography/rife')))
    sys.path.insert(0, str(directory))
    from train_log import IFNet_HDv3
    # Clamp coordinates before zero-padding: equivalent to border padding,
    # which this machine's MPS grid_sample does not implement.
    def warp(pixels, flow):
        h, w = pixels.shape[-2:]
        y, x = torch.meshgrid(torch.linspace(-1, 1, h, device=pixels.device),
                              torch.linspace(-1, 1, w, device=pixels.device), indexing='ij')
        grid = torch.stack((x, y), -1)[None]
        delta = flow.permute(0, 2, 3, 1) / flow.new_tensor([(w-1)/2, (h-1)/2])
        return torch.nn.functional.grid_sample(pixels, (grid+delta).clamp(-1, 1), align_corners=True)
    IFNet_HDv3.warp = warp
    device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
    net = IFNet_HDv3.IFNet().eval().to(device)
    state = torch.load(directory / 'train_log/flownet.pkl', map_location='cpu', weights_only=True)
    expected = net.state_dict()
    net.load_state_dict({k.removeprefix('module.'): v for k, v in state.items()
                         if k.removeprefix('module.') in expected})
    return net, device


def interpolate(a, b, fraction):
    if fraction <= 0:
        return a.copy()
    if fraction >= 1:
        return b.copy()
    assert a.size == b.size and a.mode == b.mode == 'RGBA'
    import torch
    net, device = model()
    w, h = a.size
    def tensor(image):
        pixels = np.array(image).astype('float32') / 255
        pixels[:, :, :3] *= pixels[:, :, 3:]
        value = torch.from_numpy(pixels.transpose(2, 0, 1)).unsqueeze(0).to(device)
        return torch.nn.functional.pad(value, (0, (-w) % 64, 0, (-h) % 64))
    with torch.inference_mode():
        result = net(torch.cat((tensor(a), tensor(b)), 1), fraction, [16, 8, 4, 2, 1])[-1][-1]
        pixels = result[0, :, :h, :w].cpu().numpy().transpose(1, 2, 0)
    pixels[:, :, :3] /= np.maximum(pixels[:, :, 3:4], 1/255)
    return Image.fromarray((pixels.clip(0, 1)*255).astype('uint8'), 'RGBA')

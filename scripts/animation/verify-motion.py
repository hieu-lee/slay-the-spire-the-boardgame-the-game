#!/usr/bin/env python3
"""Rigid weapon geometry must survive overlapping bones and non-square sprites."""
import importlib.util
import numpy as np
from pathlib import Path

module = importlib.util.spec_from_file_location('renderer', Path(__file__).with_name('render-rig.py'))
renderer = importlib.util.module_from_spec(module)
module.loader.exec_module(renderer)
points = np.array([[.3,.3],[.6,.3],[.6,.6],[.3,.6]])
bones = [dict(pivot=[.2,.8], regions=[[-1,-1,2,2]], attack=12, idle=2),
         dict(pivot=[.5,.5], regions=[[-1,-1,2,2]], attack=-25, idle=3,
              rigid=dict(regions=[[-1,-1,2,2]]))]
for aspect in (.5,1,2):
    distances = np.linalg.norm((points[:,None]-points[None,:])*[aspect,1],axis=-1)
    for pose in ('idle','attack'):
        for phase in np.linspace(0,1,31):
            moved = renderer.deform(points,bones,phase,pose,.4,1830,aspect)
            actual = np.linalg.norm((moved[:,None]-moved[None,:])*[aspect,1],axis=-1)
            np.testing.assert_allclose(actual,distances,atol=1e-12)
print('PASS: rigid prop distances under overlapping bones, idle/attack, and three source aspect ratios')

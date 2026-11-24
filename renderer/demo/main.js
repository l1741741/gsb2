import { circle, group, rectangle } from '../src/scene.js';
import { CanvasRenderer } from '../src/renderer.js';

const canvas = document.querySelector('#scene');
const context = canvas.getContext('2d');
const renderer = new CanvasRenderer(context);

const skyline = group({ x: 0, y: 0, zIndex: 1, children: [
  rectangle({ width: 960, height: 540, fill: '#142c43' }),
  circle({ x: 766, y: 108, radius: 44, fill: '#f2d9a2' }),
  rectangle({ x: 0, y: 330, width: 960, height: 210, fill: '#173f59' }),
  group({ x: 72, y: 210, zIndex: 1, children: [
    rectangle({ width: 130, height: 120, fill: '#24495d' }),
    rectangle({ x: 26, y: -42, width: 72, height: 42, fill: '#31596a' }),
    rectangle({ x: 50, y: -91, width: 23, height: 49, fill: '#477080' }),
  ] }),
  group({ x: 670, y: 268, zIndex: 2, children: [
    rectangle({ width: 175, height: 64, fill: '#2c5363' }),
    rectangle({ x: 22, y: 20, width: 25, height: 19, fill: '#e0ad68' }),
    rectangle({ x: 74, y: 20, width: 25, height: 19, fill: '#edcb88' }),
    rectangle({ x: 126, y: 20, width: 25, height: 19, fill: '#e0ad68' }),
  ] }),
] });

const dock = group({ x: 344, y: 400, rotation: -0.04, zIndex: 3, children: [
  rectangle({ width: 276, height: 18, fill: '#8a6548' }),
  rectangle({ x: 18, y: 18, width: 18, height: 85, fill: '#624d42' }),
  rectangle({ x: 240, y: 18, width: 18, height: 85, fill: '#624d42' }),
  group({ x: 104, y: -44, zIndex: 1, opacity: 0.94, children: [
    rectangle({ width: 78, height: 34, fill: '#d8e0d8' }),
    circle({ x: 20, y: 38, radius: 7, fill: '#122b3b' }),
    circle({ x: 60, y: 38, radius: 7, fill: '#122b3b' }),
    rectangle({ x: 52, y: 7, width: 3, height: 18, fill: '#edc783' }),
  ] }),
] });

const stars = group({ zIndex: 0, children: [
  circle({ x: 132, y: 78, radius: 2, fill: '#d8e4e7' }),
  circle({ x: 238, y: 130, radius: 1.5, fill: '#d8e4e7' }),
  circle({ x: 418, y: 72, radius: 2, fill: '#d8e4e7' }),
  circle({ x: 548, y: 154, radius: 1.5, fill: '#d8e4e7' }),
  circle({ x: 878, y: 218, radius: 2, fill: '#d8e4e7' }),
] });

renderer.render(group({ children: [skyline, dock, stars] }));

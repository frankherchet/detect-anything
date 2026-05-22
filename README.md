# Detect Anything

Static GitHub Pages app for browser-based object detection.

The page downloads TensorFlow.js models in the browser, caches the files through
a service worker, and runs webcam inference locally on the device. The model
picker supports COCO-SSD object detection variants and MoveNet pose detection.
Camera access requires HTTPS, which GitHub Pages provides.

## Local preview

```sh
python3 -m http.server 8080
```

Open <http://localhost:8080>.

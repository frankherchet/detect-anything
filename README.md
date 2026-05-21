# Detect Anything

Static GitHub Pages app for browser-based object detection.

The page downloads TensorFlow.js and the COCO-SSD model in the browser, caches
the files through a service worker, and runs webcam inference locally on the
device. Camera access requires HTTPS, which GitHub Pages provides.

## Local preview

```sh
python3 -m http.server 8080
```

Open <http://localhost:8080>.

/**
 * Image/Screenshot handler for Ripley Code
 * Supports base64 encoding for vision models
 */

const fs = require('fs');
const path = require('path');

class ImageHandler {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.pendingImages = [];

    this.supportedFormats = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    this.maxSizeBytes = 20 * 1024 * 1024; // 20MB limit
  }

  // Load an image and convert to base64
  loadImage(imagePath) {
    const fullPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(this.projectDir, imagePath);

    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${imagePath}` };
    }

    const ext = path.extname(fullPath).toLowerCase();
    if (!this.supportedFormats.includes(ext)) {
      return {
        success: false,
        error: `Unsupported format: ${ext}. Supported: ${this.supportedFormats.join(', ')}`
      };
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > this.maxSizeBytes) {
      return {
        success: false,
        error: `Image too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max: 20MB)`
      };
    }

    try {
      const buffer = fs.readFileSync(fullPath);
      const base64 = buffer.toString('base64');
      const mimeType = this.getMimeType(ext);

      return {
        success: true,
        data: {
          path: imagePath,
          base64,
          mimeType,
          size: stats.size,
          dataUrl: `data:${mimeType};base64,${base64}`
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getMimeType(ext) {
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  // Add image to pending list (to be included in next message)
  addImage(imagePath) {
    const result = this.loadImage(imagePath);
    if (result.success) {
      this.pendingImages.push(result.data);
    }
    return result;
  }

  // Get pending images and clear the list
  consumePendingImages() {
    const images = [...this.pendingImages];
    this.pendingImages = [];
    return images;
  }

  // Check if there are pending images
  hasPendingImages() {
    return this.pendingImages.length > 0;
  }

  // Get count of pending images
  getPendingCount() {
    return this.pendingImages.length;
  }

  // Clear pending images
  clearPending() {
    this.pendingImages = [];
  }

  // Format images for API request (OpenAI vision format)
  formatForAPI(images) {
    return images.map(img => ({
      type: 'image_url',
      image_url: {
        url: img.dataUrl
      }
    }));
  }

  // Format message with images for vision API
  formatMessageWithImages(textContent, images) {
    if (!images || images.length === 0) {
      return textContent;
    }

    // Return array format for vision models
    return [
      { type: 'text', text: textContent },
      ...this.formatForAPI(images)
    ];
  }

  // Find images in project
  async findImages(pattern = '**/*.{png,jpg,jpeg,gif,webp}') {
    const { glob } = require('glob');

    try {
      const files = await glob(pattern, {
        cwd: this.projectDir,
        nodir: true,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**']
      });

      return files.map(file => ({
        path: file,
        name: path.basename(file),
        ext: path.extname(file)
      }));
    } catch {
      return [];
    }
  }
}

module.exports = ImageHandler;

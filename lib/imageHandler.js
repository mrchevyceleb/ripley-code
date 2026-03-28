/**
 * Image/Screenshot handler for Banana Code
 * Supports base64 encoding for vision models
 * Includes clipboard paste support for screenshots
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');

class ImageHandler {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.pendingImages = [];

    this.supportedFormats = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    this.maxSizeBytes = 20 * 1024 * 1024; // 20MB limit

    // Temp directory for clipboard images
    this.tempDir = path.join(os.tmpdir(), 'banana-screenshots');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
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

  /**
   * Paste image from clipboard (Windows only for now)
   * Returns the image data if successful
   */
  async pasteFromClipboard() {
    const platform = process.platform;

    if (platform === 'win32') {
      return this.pasteFromClipboardWindows();
    } else if (platform === 'darwin') {
      return this.pasteFromClipboardMac();
    } else {
      return { success: false, error: 'Clipboard paste only supported on Windows and macOS' };
    }
  }

  /**
   * Windows clipboard paste using PowerShell
   */
  async pasteFromClipboardWindows() {
    const timestamp = Date.now();
    const tempFile = path.join(this.tempDir, `clipboard-${timestamp}.png`);
    const scriptFile = path.join(this.tempDir, `paste-${timestamp}.ps1`);

    // Write PowerShell script to temp file to avoid escaping issues
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
    $img.Save("${tempFile.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "SUCCESS"
} else {
    Write-Host "NO_IMAGE"
}
`;

    try {
      // Write script to temp file
      fs.writeFileSync(scriptFile, psScript, 'utf-8');

      // Execute the script file
      const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`, {
        encoding: 'utf-8',
        windowsHide: true
      }).trim();

      // Clean up script file
      try { fs.unlinkSync(scriptFile); } catch {}

      if (result === 'NO_IMAGE') {
        return { success: false, error: 'No image in clipboard. Copy a screenshot first (Win+Shift+S)' };
      }

      if (result === 'SUCCESS' && fs.existsSync(tempFile)) {
        const loadResult = this.loadImage(tempFile);
        if (loadResult.success) {
          loadResult.data.path = `clipboard-${timestamp}.png`;
          loadResult.data.isClipboard = true;
          this.pendingImages.push(loadResult.data);
          return { success: true, data: loadResult.data };
        }
        return loadResult;
      }

      return { success: false, error: 'Failed to save clipboard image' };
    } catch (error) {
      // Clean up script file on error
      try { fs.unlinkSync(scriptFile); } catch {}
      return { success: false, error: `Clipboard error: ${error.message}` };
    }
  }

  /**
   * macOS clipboard paste using pngpaste or screencapture
   */
  async pasteFromClipboardMac() {
    const timestamp = Date.now();
    const tempFile = path.join(this.tempDir, `clipboard-${timestamp}.png`);

    try {
      // Try pngpaste first (brew install pngpaste)
      try {
        execSync(`pngpaste "${tempFile}"`, { encoding: 'utf-8' });
      } catch {
        // Fallback to osascript + screencapture
        execSync(`osascript -e 'tell application "System Events" to ¬
          write (the clipboard as «class PNGf») to ¬
          (make new file at folder "${this.tempDir}" with properties {name:"clipboard-${timestamp}.png"})'`);
      }

      if (fs.existsSync(tempFile)) {
        const loadResult = this.loadImage(tempFile);
        if (loadResult.success) {
          loadResult.data.path = `clipboard-${timestamp}.png`;
          loadResult.data.isClipboard = true;
          this.pendingImages.push(loadResult.data);
          return { success: true, data: loadResult.data };
        }
        return loadResult;
      }

      return { success: false, error: 'No image in clipboard' };
    } catch (error) {
      return { success: false, error: `Clipboard error: ${error.message}` };
    }
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

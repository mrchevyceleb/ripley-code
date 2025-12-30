/**
 * Vision Analyzer for Ripley Code
 * Uses Gemini API to analyze images before sending to local LLM
 */

const fs = require('fs');
const path = require('path');

class VisionAnalyzer {
  constructor(options = {}) {
    // Gemini API endpoint - check multiple env var names
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    this.enabled = !!this.apiKey;
  }

  isEnabled() {
    return this.enabled;
  }

  /**
   * Analyze an image and return a detailed description
   * @param {Object} imageData - Image data with base64 and mimeType
   * @param {string} context - Optional context about what user wants to know
   * @returns {Promise<string>} - Analysis text
   */
  async analyzeImage(imageData, context = '') {
    if (!this.enabled) {
      return null;
    }

    const prompt = context
      ? `Analyze this image in detail. The user wants to know: "${context}"\n\nProvide a comprehensive description including:\n1. What type of content this is (UI screenshot, code, diagram, photo, etc.)\n2. All visible text, labels, and content\n3. Layout and structure\n4. Colors, styling, and design elements\n5. Any issues, errors, or notable observations\n6. Specific details relevant to the user's question`
      : `Analyze this image in comprehensive detail for a software developer. Include:\n1. What type of content this is (UI screenshot, code, diagram, error message, etc.)\n2. All visible text, labels, buttons, and content (transcribe exactly)\n3. Layout structure and hierarchy\n4. Colors, styling, fonts, spacing\n5. Any visible errors, warnings, or issues\n6. Technical observations (framework hints, patterns, accessibility concerns)\n7. What a developer would need to know to work with or fix this`;

    try {
      const response = await fetch(`${this.apiUrl}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: imageData.mimeType,
                  data: imageData.base64
                }
              }
            ]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048
          }
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Vision API error:', error);
        return null;
      }

      const data = await response.json();
      const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text;

      return analysis || null;
    } catch (error) {
      console.error('Vision analysis failed:', error.message);
      return null;
    }
  }

  /**
   * Analyze multiple images
   * @param {Array} images - Array of image data objects
   * @param {string} context - User's question/context
   * @returns {Promise<string>} - Combined analysis
   */
  async analyzeImages(images, context = '') {
    if (!this.enabled || images.length === 0) {
      return null;
    }

    const analyses = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imgContext = images.length > 1
        ? `Image ${i + 1} of ${images.length}. ${context}`
        : context;

      const analysis = await this.analyzeImage(img, imgContext);
      if (analysis) {
        analyses.push(`**[Image ${i + 1}: ${img.path || 'uploaded'}]**\n${analysis}`);
      }
    }

    if (analyses.length === 0) {
      return null;
    }

    return analyses.join('\n\n---\n\n');
  }

  /**
   * Format analysis for inclusion in prompt
   * @param {string} analysis - The image analysis
   * @returns {string} - Formatted for prompt injection
   */
  formatForPrompt(analysis) {
    if (!analysis) return '';

    return `
<image_analysis>
The following is an AI-generated analysis of the attached image(s). Use this information to understand what the user is showing you:

${analysis}
</image_analysis>

`;
  }
}

module.exports = VisionAnalyzer;

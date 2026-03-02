/**
 * Vision Analyzer for Ripley Code v4
 *
 * Primary: Send images directly to local vision models (Qwen3 VL) via LM Studio
 * Fallback: Use Gemini API to analyze images when non-vision model is loaded
 */

const fs = require('fs');
const path = require('path');

class VisionAnalyzer {
  constructor(options = {}) {
    // Gemini API endpoint - fallback for non-vision models
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    this.geminiEnabled = !!this.apiKey;
  }

  /**
   * Check if any vision capability is available
   */
  isEnabled() {
    return this.geminiEnabled;
  }

  /**
   * Build a multimodal message for LM Studio (OpenAI-compatible format)
   * Use this when the current model supports vision natively.
   * @param {string} text - The user's message text
   * @param {Array} images - Array of {base64, mimeType, path} objects
   * @returns {Object} - A message object with multimodal content array
   */
  buildMultimodalMessage(text, images) {
    const content = [
      { type: 'text', text }
    ];
    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.base64}`
        }
      });
    }
    return { role: 'user', content };
  }

  /**
   * Analyze an image via Gemini API (fallback when local model isn't vision-capable)
   * @param {Object} imageData - Image data with base64 and mimeType
   * @param {string} context - Optional context about what user wants to know
   * @returns {Promise<string>} - Analysis text
   */
  async analyzeImage(imageData, context = '') {
    if (!this.geminiEnabled) {
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
   * Analyze multiple images via Gemini (fallback)
   * @param {Array} images - Array of image data objects
   * @param {string} context - User's question/context
   * @returns {Promise<string>} - Combined analysis
   */
  async analyzeImages(images, context = '') {
    if (!this.geminiEnabled || images.length === 0) {
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

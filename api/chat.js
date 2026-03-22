// api/chat.js
export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message, mode, history } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'Server configuration error: missing API key' });
    }

    // Build the conversation with dynamic system prompt based on mode
    const systemPrompts = {
        chat: "You are a friendly, concise AI assistant. Provide clear and simple answers. Be helpful and conversational. Keep responses natural and engaging.",
        research: "You are an expert research assistant. Provide deep, structured explanations, cite concepts, use headings, bullet points, and detailed analysis. Be thorough, well-organized, and academic in tone. Use markdown formatting with sections, lists, and emphasis where appropriate.",
        study: "You are a specialized JEE/NDA level tutor. Teach step-by-step, break down concepts thoroughly, use examples, and encourage understanding. Format with bullet points, clear sections, and practical examples. Focus on conceptual clarity and problem-solving approach."
    };

    const systemPrompt = systemPrompts[mode] || systemPrompts.chat;

    // Prepare messages array: include system prompt and full history
    const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).filter(msg => msg.role !== 'system'), // avoid duplicate system prompts
        { role: 'user', content: message }
    ];

    try {
        // Set up streaming headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000',
                'X-Title': 'AI OS Chat'
            },
            body: JSON.stringify({
                model: 'openai/gpt-3.5-turbo',
                messages: messages,
                stream: true,
                temperature: 0.7,
                max_tokens: 2000
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} - ${errorData}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        if (content) {
                            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
                        }
                    } catch (e) {
                        // Skip invalid JSON
                        continue;
                    }
                }
            }
        }

        res.end();

    } catch (error) {
        console.error('Streaming error:', error);
        // If headers not sent yet, send error as JSON
        if (!res.headersSent) {
            return res.status(500).json({ error: error.message || 'Internal server error' });
        }
        // Otherwise send error through stream
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
    }
}

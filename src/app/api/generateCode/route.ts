
import { GoogleGenerativeAI } from "@google/generative-ai";
import { HfInference } from "@huggingface/inference";
import { z } from "zod";
import shadcnDocs from "@/components/ui/index";
import dedent from "dedent";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const result = z
      .object({
        model: z.string(),
        imageUrl: z.string(),
        shadcn: z.boolean().default(false),
      })
      .safeParse(json);

    if (!result.success) {
      console.error("Validation error:", result.error.message);
      return new Response(result.error.message, { status: 422 });
    }

    const { model, imageUrl, shadcn } = result.data;
    const codingPrompt = getCodingPrompt(shadcn);

    let descriptionFromModel = "";
    let genAI;
    let geminiModel;

    // Initialize Google Generative AI for Gemini
    let apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";
    genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    if (model === "meta-llama") {
      let client = new HfInference(process.env.NEXT_PUBLIC_HF_API_KEY || "");
      let out = "";
      let success = false;

      try {
        const stream = await client.chatCompletionStream({
          model: "meta-llama/Llama-3.2-11B-Vision-Instruct",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: getDescriptionPrompt
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageUrl
                  }
                }
              ]
            }
          ],
          max_tokens: 500
        });

        for await (const chunk of stream) {
          if (chunk.choices && chunk.choices.length > 0) {
            const newContent = chunk.choices[0].delta.content;
            out += newContent;
          }
        }
        success = true;
      } catch (error: any) { // Type error fixed
        if (error.message?.includes("Too Many Requests")) {
          // Try with backup API key
          client = new HfInference(process.env.NEXT_PUBLIC_HF_API_KEY_2 || "");
          const stream = await client.chatCompletionStream({
            model: "meta-llama/Llama-3.2-11B-Vision-Instruct",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: getDescriptionPrompt
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: imageUrl
                    }
                  }
                ]
              }
            ],
            max_tokens: 500
          });

          for await (const chunk of stream) {
            if (chunk.choices && chunk.choices.length > 0) {
              const newContent = chunk.choices[0].delta.content;
              out += newContent;
            }
          }
          success = true;
        } else {
          throw error;
        }
      }

      if (!success) {
        throw new Error("Failed to get response from Hugging Face");
      }

      descriptionFromModel = out;

      // Generate code based on the description using the same model
      const codeStream = await client.chatCompletionStream({
        model: "meta-llama/Llama-3.2-11B-Vision-Instruct",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: codingPrompt + "\n" + descriptionFromModel + "\nPlease ONLY return code, NO backticks or language names."
              }
            ]
          }
        ],
        max_tokens: 2000
      });

      let codeOutput = "";
      for await (const chunk of codeStream) {
        if (chunk.choices && chunk.choices.length > 0) {
          const newContent = chunk.choices[0].delta.content;
          codeOutput += newContent;
        }
      }

      const textStream = new ReadableStream({
        start(controller) {
          controller.enqueue(codeOutput);
          controller.close();
        }
      }).pipeThrough(new TextEncoderStream());

      return new Response(textStream, {
        headers: new Headers({
          "Cache-Control": "no-cache",
        }),
      });

    } else {
      // Fetch the image data
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error("Failed to fetch the image.");
      }
      
      const imageArrayBuffer = await imageResponse.arrayBuffer();
      const imageBuffer = Buffer.from(imageArrayBuffer);
      const mimeType = imageResponse.headers.get("content-type") || "image/jpeg";

      let initialResult;
      let codeResult;
      let success = false;

      try {
        // Generate initial description using the image
        initialResult = await geminiModel.generateContent([
          { text: getDescriptionPrompt },
          {
            inlineData: {
              data: imageBuffer.toString('base64'),
              mimeType: mimeType
            }
          }
        ]);

        descriptionFromModel = initialResult.response.text();

        // Generate code based on the description
        codeResult = await geminiModel.generateContent([
          { text: codingPrompt },
          { text: descriptionFromModel + "\nPlease ONLY return code, NO backticks or language names." }
        ]);

        success = true;
      } catch (error: any) { // Type error fixed
        if (error.message?.includes("Too Many Requests")) {
          // Try with backup API key
          apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY_2 || "";
          genAI = new GoogleGenerativeAI(apiKey);
          geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

          // Retry with backup key
          initialResult = await geminiModel.generateContent([
            { text: getDescriptionPrompt },
            {
              inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: mimeType
              }
            }
          ]);

          descriptionFromModel = initialResult.response.text();

          codeResult = await geminiModel.generateContent([
            { text: codingPrompt },
            { text: descriptionFromModel + "\nPlease ONLY return code, NO backticks or language names." }
          ]);

          success = true;
        } else {
          throw error;
        }
      }

      if (!success) {
        throw new Error("Failed to get response from Gemini");
      }

      const textStream = new ReadableStream({
        start(controller) {
          controller.enqueue(codeResult.response.text());
          controller.close();
        }
      }).pipeThrough(new TextEncoderStream());

      return new Response(textStream, {
        headers: new Headers({
          "Cache-Control": "no-cache",
        }),
      });
    }

  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response("Internal server error", { status: 500 });
  }
}

let getDescriptionPrompt = `Describe the attached screenshot in detail. I will send what you give me to a developer to recreate the original screenshot of a website that I sent you. Please listen very carefully. It's very important for my job that you follow these instructions:

- Think step by step and describe the UI in great detail.
- Make sure to describe where everything is in the UI so the developer can recreate it and if how elements are aligned
- Pay close attention to background color, text color, font size, font family, padding, margin, border, etc. Match the colors and sizes exactly.
- Make sure to mention every part of the screenshot including any headers, footers, sidebars, etc.
- Make sure to use the exact text from the screenshot.
`;

function getCodingPrompt(shadcn: boolean) {
    let systemPrompt = `
  You are an expert frontend frontend React developer. You will be given a description of a website from the user, and then you will return code for it  using React and Tailwind CSS. Follow the instructions carefully, it is very important for my job. I will tip you $1 million if you do a good job:
  - Think carefully step by step about how to recreate the UI described in the prompt.
  - Create a React component for whatever the user asked you to create and make sure it can run by itself by using a default export
  - Feel free to have multiple components in the file, but make sure to have one main component that uses all the other components
  - Make sure the website looks exactly like the screenshot described in the prompt.
  - Pay close attention to background color, text color, font size, font family, padding, margin, border, etc. Match the colors and sizes exactly.
  - Make sure to code every part of the description including any headers, footers, etc.
  - Use the exact text from the description for the UI elements.
  - Do not add comments in the code such as "<!-- Add other navigation links as needed -->" and "<!-- ... other news items ... -->" in place of writing the full code. WRITE THE FULL CODE.
  - Repeat elements as needed to match the description. For example, if there are 15 items, the code should have 15 items. DO NOT LEAVE comments like "<!-- Repeat for each news item -->" or bad things will happen.
  - For all images, please use an svg with a white, gray, or black background and don't try to import them locally or from the internet.
  - Make sure the React app is interactive and functional by creating state when needed and having no required props
  - If you use any imports from React like useState or useEffect, make sure to import them directly
  - Use TypeScript as the language for the React component
  - Use Tailwind classes for styling. DO NOT USE ARBITRARY VALUES (e.g. \`h-[600px]\`). Make sure to use a consistent color palette.
  - Use margin and padding to style the components and ensure the components are spaced out nicely
  - Please return the full React code starting with the imports, nothing else. DO NOT add any backticks or language identifiers.
  - Please ONLY return the full React code starting with the imports, nothing else. It's very important for my job that you only return the React code with imports. DO NOT START WITH \`\`\`typescript or \`\`\`javascript or \`\`\`tsx or \`\`\`.
  - ONLY IF the user asks for a dashboard, graph or chart, the recharts library is available to be imported, e.g. \`import { LineChart, XAxis, ... } from "recharts"\` & \`<LineChart ...><XAxis dataKey="name"> ...\`. Please only use this when needed.
  - If you need an icon, please create an SVG for it and use it in the code. DO NOT IMPORT AN ICON FROM A LIBRARY.
  - Make the design look nice and don't have borders around the entire website even if that's described
  - When importing shadcn components, always use absolute paths starting with "/components/ui/" instead of "@/components/ui/"
    `;

  if (shadcn) {
    systemPrompt += `
    There are some prestyled components available for use. Please use your best judgement to use any of these components if the app calls for one.

    Here are the components that are available, along with how to import them, and how to use them:

    ${shadcnDocs
      .map(
        (component) => `
          <component>
          <name>
          ${component.name}
          </name>
          <import-instructions>
          ${component.importDocs}
          </import-instructions>
          <usage-instructions>
          ${component.usageDocs}
          </usage-instructions>
          </component>
        `
      )
      .join("\n")}
    `;
  }

  systemPrompt += `
    NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR ABLE TO BE IMPORTED.
  `;

  systemPrompt += `
  Here are some examples of good outputs:

${examples
  .map(
    (example) => `
      <example>
      <input>
      ${example.input}
      </input>
      <output>
      ${example.output}
      </output>
      </example>
  `
  )
  .join("\n")}
  `;

  return dedent(systemPrompt);
}

let examples = [
  {
    input: `The UI mockup is a website design for an AI tool, featuring a clean and modern aesthetic. Here\'s a detailed breakdown of the design:\n\n**Header Section**\n\n* The header section is located at the top of the page and spans the full width.\n* It has a light gray background color (#F7F7F7) with a subtle shadow effect.\n* The header contains the following elements:\n\t+ A logo on the left side, which is a small black square with the text "LOGO" in white font.\n\t+ A navigation menu with four items: "Features", "About", "Pricing", and "Sign up". The text is in black font, and the links are aligned to the right.\n\t+ A search bar on the right side, which is a small oval-shaped input field with a magnifying glass icon.\n\n**Hero Section**\n\n* The hero section is located below the header and takes up most of the page.\n* It has a white background color (#FFFFFF) with a subtle gradient effect.\n* The hero section contains the following elements:\n\t+ A large heading that reads "Welcome to your all-in-one AI tool" in bold, black font (font-size: 36px; font-family: Open Sans).\n\t+ A subheading that reads "Check out all the new features in the 13.2 update in the demo below" in smaller, gray font (font-size: 18px; font-family: Open Sans).\n\t+ A call-to-action (CTA) button that reads "Get Started" in white font on a black background (font-size: 18px; font-family: Open Sans).\n\t+ An image placeholder on the right side, which is a large gray rectangle with the text "IMAGE PLACEHOLDER" in black font.\n\n**Footer Section**\n\n* The footer section is located at the bottom of the page and spans the full width.\n* It has a light gray background color (#F7F7F7) with a subtle shadow effect.\n* The footer contains the following elements:\n\t+ A copyright notice that reads "Used by 100+ companies" in small, gray font (font-size: 12px; font-family: Open Sans).\n\t+ A link to the company\'s website, which is a small text link that reads "Get Started" in blue font (font-size: 12px; font-family: Open Sans).\n\nOverall, the design is clean, modern, and easy to navigate. The use of a consistent color scheme and typography helps to create a cohesive look and feel throughout the website.`,
    output: `
import { Button } from "@/components/ui/button"

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center">
            <div className="w-8 h-8 bg-black mr-2"></div>
            <span className="font-bold text-xl">LOGO</span>
          </div>
          <nav className="hidden md:flex space-x-8">
            <a href="#features" className="text-gray-700 hover:text-gray-900">Features</a>
            <a href="#about" className="text-gray-700 hover:text-gray-900">About</a>
            <a href="#pricing" className="text-gray-700 hover:text-gray-900">Pricing</a>
          </nav>
          <Button variant="outline" className="rounded-full">Sign up</Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-block px-4 py-2 rounded-full bg-gray-200 text-sm text-gray-700 mb-6">
              Used by 100+ companies
            </div>
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Welcome to your all-in-one AI tool
            </h1>
            <p className="text-xl text-gray-600 mb-8">
              Check out all the new features in the 13.2 update in the demo below
            </p>
            <Button className="rounded-full px-8 py-3 bg-black text-white hover:bg-gray-800">
              Get Started
            </Button>
          </div>
          <div className="bg-gray-300 aspect-video rounded-lg flex items-center justify-center">
            <span className="text-gray-600 text-2xl">IMAGE PLACEHOLDER</span>
          </div>
        </div>
      </main>
    </div>
  )
}
    `,
  },
];
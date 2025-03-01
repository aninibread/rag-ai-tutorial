/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from "hono";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { WorkflowEntrypoint} from 'cloudflare:workers'

const app = new Hono();

// Existing post route...
// app.post('/notes', async (c) => { ... })

app.get('/', async (c) => {
  const question = c.req.query('text') || "What is the square root of 9?"

  const embeddings = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: question })
  const vectors = embeddings.data[0]

  const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 1 });
  let vecId;
  if (vectorQuery.matches && vectorQuery.matches.length > 0 && vectorQuery.matches[0]) {
    vecId = vectorQuery.matches[0].id;
  } else {
    console.log("No matching vector found or vectorQuery.matches is empty");
  }

  let notes = []
  if (vecId) {
    const query = `SELECT * FROM notes WHERE id = ?`
    const { results } = await c.env.DB.prepare(query).bind(vecId).all()
    if (results) notes = results.map(vec => vec.text)
  }

  const contextMessage = notes.length
    ? `Context:\n${notes.map(note => `- ${note}`).join("\n")}`
    : ""

  const systemPrompt = `When answering the question or responding, use the context provided, if it is provided and relevant.`

  const { response: answer } = await c.env.AI.run(
    '@cf/meta/llama-3-8b-instruct',
    {
      messages: [
        ...(notes.length ? [{ role: 'system', content: contextMessage }] : []),
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ]
    }
  )

  return c.text(answer);
});

app.onError((err, c) => {
  return c.text(err);
});

export default app;

app.post('/notes', async (c) => {
	const { text } = await c.req.json();
	if (!text) {
		console.error("Missing text in request body");
		return c.text("Missing text", 400);
	}
	await c.env.RAG_WORKFLOW.create({ params: {text} });
	return c.text("Created note", 201);
})

app.delete("/notes/:id", async (c) => {
	const { id } = c.req.param();
  
	const query = `DELETE FROM notes WHERE id = ?`;
	await c.env.DB.prepare(query).bind(id).run();
  
	await c.env.VECTOR_INDEX.deleteByIds([id]);
  
	return c.status(204);
  });


export class RAGWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const env = this.env
		const {text} = event.payload;

		if (!text) {
			console.error("Received undefined text in workflow", text, params);
			throw new Error("Missing text parameter");
		}
  
	   	const record = await step.do('create database record', async () => {
	 		const query = "INSERT INTO notes (text) VALUES (?) RETURNING *"
	
	 		const { results } = await env.DB.prepare(query)
	 			.bind(text)
	 			.run()
	
	 		const record = results[0]
	 		if (!record) throw new Error("Failed to create note")
	 		return record;

	 		})
  
	   	const embedding = await step.do('generate embedding', async () => {
	 		const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: text })
	 		const values = embeddings.data[0]
	 		if (!values) throw new Error("Failed to generate vector embedding")
	 		return values
	 		})
	
	 		await step.do(`insert vector`, async () => {
	 			return env.VECTOR_INDEX.upsert([
	 			{
	 				id: record.id.toString(),
	 				values: embedding,
	 			}
	 		]);
	   })
	}
}


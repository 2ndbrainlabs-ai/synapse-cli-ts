import express, { Request, Response, Router } from 'express';

const router: Router = express.Router();

interface Task {
  id: number;
  title: string;
  done: boolean;
}

/** List all tasks. */
router.get('/tasks', (req: Request, res: Response) => {
  res.json([]);
});

/** Get a task by ID. */
router.get('/tasks/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  res.json({ id, title: 'Buy milk', done: false });
});

/** Create a new task. */
router.post('/tasks', (req: Request, res: Response) => {
  const task: Task = req.body;
  res.status(201).json(task);
});

/** Update a task. */
router.put('/tasks/:id', (req: Request, res: Response) => {
  const task: Task = { ...req.body, id: parseInt(req.params.id) };
  res.json(task);
});

/** Delete a task. */
router.delete('/tasks/:id', (req: Request, res: Response) => {
  res.status(204).send();
});

export default router;

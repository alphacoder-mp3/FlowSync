'use server';

import { prisma } from '@/lib/prisma';
import { revalidatePath } from 'next/cache';

export async function createTodo(
  formData: FormData,
  userId: string,
  bgColor?: string
): Promise<{ success: boolean; error: boolean; message: string }> {
  const title = (formData.get('title') as string) || '';
  const description = (formData.get('description') as string) || '';
  const done = formData.get('done') === 'true';

  if (!title && !description) {
    return {
      success: false,
      error: true,
      message: 'At least one of title or description is required',
    };
  }

  await prisma.$transaction(async prisma => {
    const todo = await prisma.todo.create({
      data: {
        title,
        description,
        done,
        todoColor: bgColor,
        user: { connect: { id: userId } },
        lastModifiedBy: userId,
      },
    }); //previously we just had this call prisma todo create call

    // Automatically add the creator as a collaborator with isOwner: true
    await prisma.collaborator.create({
      data: {
        userId,
        todoId: todo.id,
        isOwner: true,
      },
    });
  });

  revalidatePath('/');
  return { success: true, message: 'Created note successfully', error: false };
}

export async function deleteTodo(
  id: string,
  userId: string
): Promise<{ success: boolean; error: boolean; message: string }> {
  try {
    const todo = await prisma.todo.findUnique({
      where: { id },
      select: { userId: true },
    });

    if (!todo) {
      return { success: false, error: true, message: 'Note not found' };
    }

    if (todo.userId !== userId) {
      return {
        success: false,
        error: true,
        message: 'You are not authorized to delete this note',
      };
    }

    await prisma.todo.delete({
      where: { id },
    });

    revalidatePath('/');

    return {
      success: true,
      message: 'Deleted note successfully',
      error: false,
    };
  } catch (error) {
    return { success: false, error: true, message: error as string };
  }
}

export async function updateTodo(
  id: string,
  formData: FormData,
  userId: string,
  bgColor?: string,
  pinned?: boolean
): Promise<{ success: boolean; error: boolean; message: string }> {
  try {
    const todo = await prisma.todo.findUnique({
      where: { id },
      include: {
        collaborators: {
          select: { userId: true },
        },
      },
    });

    if (!todo) {
      return {
        success: false,
        error: true,
        message: 'Note not found',
      };
    }

    const isOwner = todo.userId === userId;
    const isCollaborator = todo.collaborators.some(
      collab => collab.userId === userId
    );

    if (!isOwner && !isCollaborator) {
      return {
        success: false,
        error: true,
        message: 'You are not authorized to update this note',
      };
    }

    const title = formData.get('title') as string;
    const description = formData.get('description') as string;
    const done = formData.get('done') === 'true';

    if (!title && !description) {
      return {
        success: false,
        error: true,
        message: 'At least one of title or description is required',
      };
    }

    if (todo) {
      await prisma.todoHistory.create({
        data: {
          todoId: id,
          title: todo.title || '',
          description: todo.description || '',
          done: todo.done,
          pinned: todo.pinned,
          todoColor: todo.todoColor,
          lastModifiedBy: todo.lastModifiedBy ?? userId,
          createdAt: todo.updatedAt,
        },
      });
    } //This is to keep the track of todo history

    await prisma.todo.update({
      where: { id },
      data: {
        title,
        description,
        done,
        pinned,
        todoColor: bgColor,
        lastModifiedBy: userId,
      },
    });

    revalidatePath('/');

    return {
      success: true,
      error: false,
      message: 'Updated note successfully',
    };
  } catch (error) {
    console.error('Error updating note:', error);
    return {
      success: false,
      error: true,
      message:
        error instanceof Error ? error.message : 'An unknown error occurred',
    };
  }
}

export async function getTodo(
  userId: string,
  page: number = 1,
  limit: number = 10
): Promise<{
  success: boolean;
  error: boolean;
  message: string;
  todo: {
    title: string;
    description: string;
    done: boolean;
    pinned: boolean;
    id: string;
    todoColor: string;
    updatedAt: Date;
    createdAt: Date;
    lastModifiedBy: string;
    user: { username: string };
    images: {
      id: string;
      url: string;
    }[];
    collaborators: {
      id: string;
      isOwner: boolean;
      user: {
        id: string;
        username: string;
        name: string | null;
        image: string | null;
        email: string;
      };
    }[];
  }[];
  totalCount: number;
  currentPage: number;
  totalPages: number;
}> {
  if (!userId) {
    return {
      success: false,
      error: true,
      message: 'User ID is required',
      todo: [],
      totalCount: 0,
      currentPage: page,
      totalPages: 0,
    };
  }

  if (page < 1) page = 1;
  if (limit < 1) limit = 10;
  try {
    const skip = (page - 1) * limit;

    const [todos, totalCount] = await Promise.all([
      prisma.todo.findMany({
        where: {
          OR: [{ userId }, { collaborators: { some: { userId } } }],
        },
        select: {
          title: true,
          description: true,
          done: true,
          pinned: true,
          id: true,
          todoColor: true,
          updatedAt: true,
          createdAt: true,
          lastModifiedBy: true,
          user: {
            select: {
              username: true,
            },
          },
          images: {
            select: {
              url: true,
              id: true,
            },
          },
          collaborators: {
            select: {
              id: true,
              isOwner: true,
              user: {
                select: {
                  id: true,
                  username: true,
                  name: true,
                  image: true,
                  email: true,
                },
              },
            },
          },
        },
        skip,
        take: limit,
        orderBy: [
          { pinned: 'desc' }, // pinned ones come first
          { createdAt: 'desc' }, // newest first within pinned/unpinned groups
        ],
      }),
      prisma.todo.count({
        where: {
          OR: [{ userId }, { collaborators: { some: { userId } } }],
        },
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return {
      success: true,
      error: false,
      message: 'Fetched note details successfully',
      todo: todos || [],
      // todo:
      //   todos.map(todo => ({
      //     ...todo,
      //     user: {
      //       ...todo.user,
      //       username: todo.user.username ?? 'Unknown', // Provide a fallback for null username
      //     },
      //     collaborators: todo.collaborators.map(collab => ({
      //       ...collab,
      //       user: {
      //         ...collab.user,
      //         username: collab.user.username ?? 'Unknown', // Provide a fallback for null username in collaborators
      //       },
      //     })),
      //   })) || [], // This will be an empty array if no notes are found
      totalCount,
      currentPage: page,
      totalPages,
    };
  } catch (error) {
    return {
      success: false,
      error: true,
      message:
        error instanceof Error ? error.message : 'An unknown error occurred',
      todo: [],
      totalCount: 0,
      currentPage: page,
      totalPages: 0,
    };
  }
}

export async function getTodoHistory(todoId: string) {
  return await prisma.todoHistory.findMany({
    where: { todoId },
    orderBy: { createdAt: 'desc' },
  });
}

// import { Note } from '@/types';
// export async function pinNote(noteId: string, pinned: boolean): Promise<Note> {
//   const updated = await prisma.todo.update({
//     where: { id: noteId },
//     data: { pinned },
//     select: {
//       id: true,
//       createdAt: true,
//       updatedAt: true,
//       userId: true,
//       title: true,
//       description: true,
//       done: true,
//       pinned: true,
//       todoColor: true,
//       lastModifiedBy: true,
//       user: {
//         select: {
//           id: true,
//           username: true,
//           name: true,
//           image: true,
//           email: true,
//         },
//       },
//       images: {
//         select: {
//           id: true,
//           url: true,
//         },
//       },
//       collaborators: {
//         select: {
//           id: true,
//           isOwner: true,
//           user: {
//             select: {
//               id: true,
//               username: true,
//               name: true,
//               image: true,
//               email: true,
//             },
//           },
//         },
//       },
//     },
//   });
//   return updated;
// }

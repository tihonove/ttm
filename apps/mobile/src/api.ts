import type { TodosResponse } from "./model.ts";
import type { Settings } from "./settings.ts";

export class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export async function fetchTodos(settings: Settings): Promise<TodosResponse> {
    const response = await fetch(`${settings.server.replace(/\/+$/, "")}/api/todos`, {
        headers: { authorization: `Bearer ${settings.token}` },
    });
    if (response.status === 401) throw new ApiError(401, "Токен не подходит");
    if (!response.ok) throw new ApiError(response.status, `Сервер ответил ${response.status}`);
    return (await response.json()) as TodosResponse;
}

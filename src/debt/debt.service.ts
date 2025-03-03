import { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api";
import PushkaBot from "../bot/bot.service";
import IDebt from "./debt.interface";
import IMember from "../member/member.interface";

interface INewDebtProcess {
    step: number;
    amount: number;
    debtorsIds: number[];
    debtorsIdsForDB?: number[];
    towhom?: number;
    debtsAmounts?: number[];
    currentDebtor?: IMember;
    expenseId?: number;
    tip?: number | null;
    requiredtippercentage?: number | null;
}

export default class Debts {
    newDebtProcess: { [chatId: number]: INewDebtProcess };
    deleteDebtProcess: boolean;

    constructor() {
        this.newDebtProcess = {};
        this.deleteDebtProcess = false;
    }

    /**
     * Функция выводит в чат все долги одним общим списком
     * @param bot
     * @param msg
     */
    async showAllFromDb(bot: PushkaBot, msg: Message) {
        const { chatId } = bot.getChatIdAndInputData(msg);

        try {
            let members: IMember[] = [];
            await bot.members
                .getAllFromDb(bot)
                .then((mems) => {
                    mems !== null ? (members = mems) : new Error("Can't get members");
                })
                .catch((err) => {
                    console.error(err);
                });

            const debts: IDebt[] = (await bot.db.query("SELECT * FROM debts")).rows;

            if (debts.length === 0) {
                bot.sendMessage(chatId, "Долгов пока нет");
            } else {
                let message = "Текущие долги:";
                for (const debt of debts) {
                    const debtState = debt.resolve ? "Погашен ✅" : "Не погашен ⛔️";

                    const whoseDebt = members.find((m) => m.member_id === debt.whosedebt)?.name;

                    const toWhom = members.find((m) => m.member_id === debt.towhom)?.name;

                    message += "\n" + `- ${whoseDebt} должен ${toWhom} ${debt.debt}, статус: ${debtState}`;
                }
                await bot.sendMessage(chatId, message);
            }
        } catch (err) {
            await bot.sendMessage(chatId, "Ошибка вывода долгов");
        }
    }

    /**
     * Функция выводит в чат все долги, посчитанные для каждого участника отдельно
     * @param bot
     * @param msg
     * @returns
     */
    async calcdebts(bot: PushkaBot, msg: Message): Promise<void> {
        const { chatId } = bot.getChatIdAndInputData(msg);

        try {
            const debts: IDebt[] = (await bot.db.query("SELECT * FROM debts")).rows;

            const members: IMember[] = (await bot.db.query("SELECT * FROM members")).rows;

            if (debts.length === 0) {
                await bot.sendMessage(chatId, "Нет долгов для расчета.");
                return;
            }

            const debtMap: { [key: number]: { [key: number]: number } } = {};

            for (const debt of debts) {
                const { debt: amount, towhom, whosedebt, resolve } = debt;

                if (!debtMap[whosedebt]) debtMap[whosedebt] = {};
                if (!debtMap[whosedebt][towhom]) debtMap[whosedebt][towhom] = 0;

                if (!resolve) {
                    debtMap[whosedebt][towhom] += amount;
                }
            }

            let message = "Текущие долги между участниками:\n";

            for (const debtorId in debtMap) {
                for (const creditorId in debtMap[debtorId]) {
                    const amountOwed = debtMap[debtorId][creditorId];
                    if (amountOwed > 0) {
                        const debtorName = members.find((member) => member.member_id === +debtorId)?.name;
                        const creditorName = members.find((member) => member.member_id === +creditorId)?.name;

                        message += `- ${debtorName} должен ${creditorName} ${amountOwed}\n`;
                    } else {
                        message = "Долгов нет!";
                    }
                }
            }

            await bot.sendMessage(chatId, message);
        } catch (err) {
            console.error("Ошибка расчета долгов:", err);
            await bot.sendMessage(chatId, "Ошибка расчета долгов");
        }
    }

    /**
     * Функция ставит всем долгам статус "расчитан"
     * @param bot
     * @param msg
     * @returns
     */
    async solveAllDebts(bot: PushkaBot, msg: Message) {
        const { chatId } = bot.getChatIdAndInputData(msg);

        try {
            await bot.db.query("UPDATE debts SET resolve = true;");
            await bot.sendMessage(chatId, "Все долги анулированы");
            return;
        } catch (err) {
            await bot.sendMessage(chatId, "Ошибка анулирования долгов");
            return;
        }
    }

    /**
     * Функция позволяет создать новый долг, задавая вопросы пользователю в чате
     * @param bot
     * @param msg
     * @returns
     */
    async createDebt(bot: PushkaBot, msg: Message | CallbackQuery) {
        const { chatId, inputData } = bot.getChatIdAndInputData(msg);

        const process = this.newDebtProcess[chatId];

        await bot.checkInSomeProcess(msg);

        const expenses = await bot.expenses.getAllUnresolvedExpenses(bot);
        const debtors = await bot.members.getAllFromDb(bot);

        if (!expenses || expenses.length === 0) {
            await bot.sendMessage(chatId, "Пока что нечего расчитывать, сначала создайте расход");
            return;
        }

        if (!debtors || debtors.length === 0) {
            await bot.sendMessage(chatId, "Нет участников для расчета долгов.");
            return;
        }

        if (process) {
            switch (process.step) {
                case 1:
                    const expenseId = Number(inputData);
                    const selectedExpense = expenses.find((expense) => expense.expense_id === expenseId)!;

                    if (!selectedExpense) {
                        await bot.sendMessage(chatId, "Выбранный расход не найден.");
                        return;
                    }

                    process.amount = selectedExpense.amount;
                    process.expenseId = selectedExpense.expense_id;
                    process.towhom = selectedExpense.whopaid;
                    process.debtorsIds = [...selectedExpense.whoparticipated];
                    process.debtorsIdsForDB = [...selectedExpense.whoparticipated];
                    process.tip = selectedExpense.tip;
                    process.requiredtippercentage = selectedExpense.requiredtippercentage;

                    process.step = 2;

                    await bot.sendMessage(chatId, "Можете вводить числа, разделяя их плюсом для автоматического сложения");

                    await this.promptNextDebtor(bot, chatId, process, debtors);
                    break;

                case 2:
                    let amount = this.calcTheInputString(inputData);
                    if (isNaN(amount) || amount <= 0) {
                        await bot.sendMessage(chatId, "Введите корректную сумму");
                        return;
                    }

                    if (amount > process.amount) {
                        await bot.sendMessage(chatId, "Долг не может быть больше расхода, повторите ввод, пожалуйста");
                        return;
                    }

                    let actualDebt = amount;

                    if (process.requiredtippercentage !== null) {
                        const tipMultiplier = process.requiredtippercentage! / 100 + 1;
                        actualDebt = Math.round(actualDebt * tipMultiplier);
                    }

                    if (process.tip !== null) {
                        const tipPart = Math.round(process.tip! / (process.debtorsIdsForDB!.length + 1));
                        actualDebt += tipPart;
                    }

                    process.debtsAmounts!.push(Math.round(actualDebt));

                    if (process.debtorsIds.length > 0) {
                        await this.promptNextDebtor(bot, chatId, process, debtors);
                    } else {
                        await this.saveDebts(bot, process);
                        await bot.sendMessage(chatId, "Долги успешно сохранены!");
                        await bot.expenses.resolveExpense(bot, chatId, process.expenseId!);
                        this.deleteStates(bot, chatId);
                    }
                    break;

                default:
                    await bot.sendMessage(chatId, "Произошла ошибка составления долга, попробуйте ещё раз");
                    this.deleteStates(bot, chatId);
                    break;
            }
            return;
        }

        this.newDebtProcess[chatId] = {
            step: 1,
            amount: 0,
            debtorsIds: [],
            debtsAmounts: [],
        };
        bot.process = true;

        const options: InlineKeyboardButton[] = expenses!.map((expense) => ({
            text: `${expense.amount} в ${expense.description}`,
            callback_data: `${expense.expense_id}`,
        }));

        options.push({
            text: "Отмена",
            callback_data: "cancel",
        });

        await bot.sendMessage(chatId, "Выберите, какой расход сейчас посчитаем:", {
            reply_markup: {
                inline_keyboard: [...options.map((button) => [button])],
            },
        });
    }

    /**
     * Функция спрашивает потраченную сумму, каждым участником, участвовавшим в расходе
     * @param bot
     * @param charId
     * @param process
     * @param debtors
     */
    private async promptNextDebtor(bot: PushkaBot, chatId: number, process: INewDebtProcess, debtors: IMember[]) {
        const currentDebtorId = process.debtorsIds.pop();
        process.currentDebtor = debtors.find((debtor) => debtor.member_id === currentDebtorId);

        if (process.currentDebtor) {
            await bot.sendMessage(chatId, `Сколько наел(а) ${process.currentDebtor.name}?`);
        }
    }

    private calcTheInputString(inputData: string): number {
        const numbers = inputData.split("+").map((num) => parseFloat(num.trim()));
        const sum = numbers.reduce((acc, num) => (acc += num), 0);
        return sum;
    }

    /**
     * Функция сохраняет переданные в объекте process долги в базе данных
     * @param bot
     * @param process
     */
    private async saveDebts(bot: PushkaBot, process: INewDebtProcess) {
        for (let i = 0; i < process.debtorsIdsForDB!.length; i++) {
            const debtAmount = process.debtsAmounts!.pop()!;
            const debtorId = process.debtorsIdsForDB![i];

            const debt: Omit<IDebt, "debt_id"> = {
                debt: debtAmount,
                towhom: process.towhom!,
                whosedebt: debtorId,
                fromexpense: process.expenseId!,
                resolve: false,
            };

            await bot.db.query(
                `INSERT INTO debts(debt, towhom, whosedebt, fromexpense, resolve)
                VALUES ($1, $2, $3, $4, false)`,
                [debt.debt, debt.towhom, debt.whosedebt, debt.fromexpense],
            );
        }
    }

    /**
     * Функция позволяет удалить 1 конкретный долг, выбирает пользователь из списка в чате
     * @param bot
     * @param msg
     * @returns
     */
    async deleteOneDebt(bot: PushkaBot, msg: Message | CallbackQuery) {
        const { chatId, inputData } = bot.getChatIdAndInputData(msg);

        const process = this.deleteDebtProcess;

        if (await bot.checkInSomeProcess(msg)) {
            return;
        }

        const debts: IDebt[] = (await bot.db.query("SELECT * FROM debts;")).rows;

        if (debts.length === 0) {
            await bot.sendMessage(chatId, "Нечего удалять");
            return;
        }

        const members: IMember[] = (await bot.db.query("SELECT * FROM members")).rows;

        if (process) {
            switch (process) {
                case true:
                    const debt_id = +inputData;
                    if (debt_id && typeof debt_id === "number") {
                        await bot.db.query("DELETE FROM debts WHERE debt_id = $1", [debt_id]);
                        await bot.sendMessage(chatId, "Долг успешно удалён");
                    }

                    this.deleteStates(bot, chatId);
                    break;
                default:
                    await bot.sendMessage(chatId, "Ошибка удаления долга, попробуйте ещё раз");

                    this.deleteStates(bot, chatId);
                    break;
            }
            return;
        }

        this.deleteDebtProcess = true;
        bot.process = true;

        const options: InlineKeyboardButton[] = debts.map((debt) => ({
            text: `Долг ${debt.debt} ${members.find((member) => member.member_id === debt.whosedebt)?.name} для ${members.find((member) => member.member_id === debt.towhom)?.name}`,
            callback_data: `${debt.debt_id}`,
        }));

        await bot.sendMessage(chatId, "Выберите какой долг удалить:", {
            reply_markup: {
                inline_keyboard: [...options.map((button) => [button])],
            },
        });
    }

    /**
     * Функция удаляет все долги из базы данных
     * @param bot
     * @param msg
     */
    async deleteAllDebts(bot: PushkaBot, msg: Message) {
        const { chatId } = bot.getChatIdAndInputData(msg);
        try {
            await bot.db.query("DELETE FROM debts");
            await bot.db.query("ALTER SEQUENCE debts_debt_id_seq RESTART WITH 1;");
            await bot.sendMessage(chatId, "Все долги успешно удалены");
        } catch (err) {
            await bot.sendMessage(chatId, "Ошибка удаления долгов");
        }
    }

    /**
     * Функция обнуляет все статусы процессов создания или удаления долга
     * @param bot
     * @param chatId
     */
    deleteStates(bot: PushkaBot, chatId: number) {
        this.deleteDebtProcess = false;
        delete this.newDebtProcess[chatId];
        bot.process = false;
    }
}

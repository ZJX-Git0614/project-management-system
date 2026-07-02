"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";

interface RoleConfigItem {
  id: string;
  roleName: string;
  allowMultiple: boolean;
  systemPreset: boolean;
  persons: string[];
}

interface CreateProjectForm {
  name: string;
  code: string;
  clientName: string;
  amountWan: number;
  deviceCount: number;
  repairCycleDays: number;
  startDate: string;
  initialMember?: {
    roleName: string;
    personName: string;
  };
}

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateProjectForm) => void;
  disabled?: boolean;
  roleConfigs: RoleConfigItem[];
}

const INITIAL_FORM: CreateProjectForm = {
  name: "",
  code: "",
  clientName: "",
  amountWan: 0,
  deviceCount: 0,
  repairCycleDays: 0,
  startDate: "",
};

export const CreateProjectDialog = ({ open, onClose, onSubmit, disabled, roleConfigs }: CreateProjectDialogProps) => {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<CreateProjectForm>(INITIAL_FORM);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [selectedRole, setSelectedRole] = useState("");
  const [selectedPerson, setSelectedPerson] = useState("");

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      nameInputRef.current?.focus();
      setStep(0);
      setForm(INITIAL_FORM);
      const firstRole = roleConfigs.find((role) => role.persons.length > 0) ?? roleConfigs[0];
      setSelectedRole(firstRole?.roleName ?? "");
      setSelectedPerson(firstRole?.persons[0] ?? "");
    }, 0);
    return () => clearTimeout(timer);
  }, [open, roleConfigs]);

  if (!open) return null;

  // Step 1: 项目核心信息

  const step1Valid =
    form.name.trim() &&
    form.clientName.trim() &&
    form.startDate;

  // Step 2: 项目组成员
  const roleConfig = roleConfigs.find((r) => r.roleName === selectedRole);
  const availablePersons = roleConfig?.persons ?? [];
  const step2Valid = Boolean(selectedRole.trim() && selectedPerson.trim() && availablePersons.includes(selectedPerson));

  const goToStep1 = () => setStep(0);
  const goToStep2 = () => { if (step1Valid) setStep(1); };
  const goToStep3 = () => { if (step2Valid) setStep(2); };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 0) {
      goToStep2();
      return;
    }
    if (step === 1) {
      goToStep3();
      return;
    }
    if (step === 2) {
      onSubmit({
        ...form,
        initialMember: selectedRole && selectedPerson ? { roleName: selectedRole, personName: selectedPerson } : undefined,
      });
      setForm(INITIAL_FORM);
      setStep(0);
    }
  };

  const handleClose = () => {
    setForm(INITIAL_FORM);
    setStep(0);
    onClose();
  };

  const inputClass =
    "w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <ModalDialog
      open={open}
      title={
        step === 0 ? "创建项目 · 第一步：项目核心信息" :
        step === 1 ? "创建项目 · 第二步：项目组成员" :
        "创建项目 · 第三步：确认创建"
      }
      onClose={handleClose}
      size="md"
      footer={
        <>
          <button type="button" onClick={handleClose} className="text-xs text-muted-foreground hover:text-foreground">
            取消
          </button>
          {step > 0 && (
            <button type="button" onClick={goToStep1} className="text-xs text-muted-foreground hover:text-foreground">
              上一步
            </button>
          )}
          {step < 2 && (
            <button
              type="submit"
              form="create-project-form"
              disabled={disabled || (step === 0 ? !step1Valid : !step2Valid)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一步
            </button>
          )}
          {step === 2 && (
            <button
              type="submit"
              form="create-project-form"
              disabled={disabled}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认创建
            </button>
          )}
        </>
      }
    >
      {disabled && <div className="mb-3 text-xs text-amber-700">当前角色无创建权限。</div>}

      {/* 步骤指示器 */}
      <div className="mb-4 flex items-center gap-1 text-xs">
        <div className={`flex items-center gap-1 ${step >= 0 ? "text-primary font-medium" : "text-muted-foreground"}`}>
          <span className={`flex size-5 items-center justify-center rounded-full text-[10px] ${step >= 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>1</span>
          <span>核心信息</span>
        </div>
        <div className="mx-1 h-px flex-1 bg-border" />
        <div className={`flex items-center gap-1 ${step >= 1 ? "text-primary font-medium" : "text-muted-foreground"}`}>
          <span className={`flex size-5 items-center justify-center rounded-full text-[10px] ${step >= 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>2</span>
          <span>项目成员</span>
        </div>
        <div className="mx-1 h-px flex-1 bg-border" />
        <div className={`flex items-center gap-1 ${step >= 2 ? "text-primary font-medium" : "text-muted-foreground"}`}>
          <span className={`flex size-5 items-center justify-center rounded-full text-[10px] ${step >= 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>3</span>
          <span>确认</span>
        </div>
      </div>

      <form id="create-project-form" className="space-y-3" onSubmit={handleSubmit}>
        {/* Step 1: 项目核心信息 */}
        {step === 0 && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">项目名称 *</label>
                <input
                  ref={nameInputRef}
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="项目名称"
                  required
                  disabled={disabled}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">项目编号</label>
                <input
                  value={form.code}
                  onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value }))}
                  placeholder="项目编号"
                  disabled={disabled}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">甲方单位 *</label>
              <input
                value={form.clientName}
                onChange={(e) => setForm((prev) => ({ ...prev, clientName: e.target.value }))}
                placeholder="甲方单位名称"
                required
                disabled={disabled}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">开始时间 *</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                required
                disabled={disabled}
                className={inputClass}
              />
            </div>
          </>
        )}

        {/* Step 2: 项目组成员 */}
        {step === 1 && (
          <>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="text-xs font-medium text-foreground">选择角色与人员</div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">角色</label>
                <select
                  value={selectedRole}
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    const nextPersons = roleConfigs.find((role) => role.roleName === nextRole)?.persons ?? [];
                    setSelectedRole(nextRole);
                    setSelectedPerson(nextPersons[0] ?? "");
                  }}
                  disabled={disabled}
                  className={inputClass}
                >
                  {roleConfigs.map((role) => (
                    <option key={role.id} value={role.roleName}>
                      {role.roleName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">人员</label>
                <select
                  value={selectedPerson}
                  onChange={(e) => setSelectedPerson(e.target.value)}
                  disabled={disabled || availablePersons.length === 0}
                  className={inputClass}
                >
                  <option value="" disabled>
                    {availablePersons.length === 0 ? "当前角色暂无可选人员" : "请选择人员"}
                  </option>
                  {availablePersons.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-2 text-xs text-warning-foreground">
              项目组成员来源于“项目角色与人员管理”的人员库；若当前角色无人员，请先到后台账号管理分配对应项目角色。
            </div>
          </>
        )}

        {/* Step 3: 确认创建 */}
        {step === 2 && (
          <div className="space-y-2">
            <div className="rounded-lg border border-border p-3 text-xs">
              <div className="mb-2 font-medium text-foreground">项目核心信息</div>
              <div className="grid grid-cols-2 gap-y-1.5 text-muted-foreground">
                <div>项目名称：<span className="font-medium text-foreground">{form.name}</span></div>
                <div>项目编号：<span className="font-medium text-foreground">{form.code || "-"}</span></div>
                <div>甲方单位：<span className="font-medium text-foreground">{form.clientName}</span></div>
                <div>开始时间：<span className="font-medium text-foreground">{form.startDate}</span></div>
              </div>
            </div>
            <div className="rounded-lg border border-border p-3 text-xs">
              <div className="mb-1 font-medium text-foreground">项目组成员</div>
              <div className="text-muted-foreground">
                {selectedRole}：<span className="font-medium text-foreground">{selectedPerson}</span>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              创建成功后项目默认状态为&quot;草稿&quot;，可在项目详情中继续补充。
            </div>
          </div>
        )}
      </form>
    </ModalDialog>
  );
};
